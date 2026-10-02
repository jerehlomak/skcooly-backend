const jwt = require('jsonwebtoken');
const prisma = require('../db/prisma');
const { StatusCodes } = require('http-status-codes');
const CustomError = require('../errors');
const { invalidateCache } = require('../services/redis.service');
const { getTransporter, getFromEmail } = require('../utils/emailTransporter');
const ai = require('../services/academic-ai.service');
const store = require('../services/academic-storage.service');
const { exportDocument, periodLabel, DOC_LABEL } = require('../services/academic-export.service');

const ADMIN_ROLES = ['ADMIN', 'SCHOOL_SUPER_ADMIN', 'SCHOOL_ADMIN'];
const isAdmin = (req) => ADMIN_ROLES.includes(req.user.role);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const wrapStatus = (e) => { if (e.status === 413) throw new CustomError.BadRequestError(e.message); throw e; };

const loadConfig = async (schoolId) => {
    const s = await prisma.schoolSettings.findFirst({ where: { schoolId }, select: { lessonNoteConfig: true } });
    return ai.mergeConfig(s?.lessonNoteConfig);
};

const loadSchool = async (schoolId) =>
    prisma.schoolSettings.findFirst({ where: { schoolId }, select: { schoolName: true, arabicName: true, logoUrl: true, address: true } });

/** Teachers only ever touch their own documents; admins can touch any in the school. */
const findDoc = async (req, id) => {
    const doc = await prisma.academicDocument.findFirst({
        where: { id, schoolId: req.user.schoolId, isDeleted: false, ...(isAdmin(req) ? {} : { ownerUserId: req.user.userId }) },
    });
    if (!doc) throw new CustomError.NotFoundError('Document not found');
    return doc;
};

const withoutContent = ({ contentHtml, ...rest }) => rest;

const validateMeta = (b, cfg) => {
    if (!b.title?.trim()) throw new CustomError.BadRequestError('A title is required');
    if (!ai.DOC_TYPES.includes(b.docType)) throw new CustomError.BadRequestError('Unknown document type');
    const week = b.week === '' || b.week == null ? null : Number(b.week);
    if (week !== null && !(Number.isInteger(week) && week >= 1 && week <= 60)) throw new CustomError.BadRequestError('Week must be a number from 1 to 60');
    if (cfg.requireTermWeek && b.docType !== 'CURRICULUM' && (!b.term || !b.sessionName || (b.docType !== 'SCHEME_OF_WORK' && week === null))) {
        throw new CustomError.BadRequestError(b.docType === 'SCHEME_OF_WORK' ? 'Pick the term and session before saving' : 'Pick the week, term and session before saving');
    }
    return week;
};

const metaFields = (b, week) => ({
    docType: b.docType, title: b.title.trim().slice(0, 200), term: b.term || null, week, sessionName: b.sessionName || null,
    classId: b.classId || null, className: b.className || null, subjectId: b.subjectId || null, subjectName: b.subjectName || null, curriculum: b.curriculum || null,
});

// ─── meta / settings ─────────────────────────────────────────────────────────
const getMeta = async (req, res) => {
    const schoolId = req.user.schoolId;
    const [cfg, classes, subjects, sessions, settings, storage, used] = await Promise.all([
        loadConfig(schoolId),
        prisma.class.findMany({ where: { schoolId, isDeleted: false }, select: { id: true, name: true }, orderBy: [{ order: 'asc' }, { name: 'asc' }] }),
        prisma.subject.findMany({ where: { schoolId, isDeleted: false }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
        prisma.academicSession.findMany({ where: { schoolId, isDeleted: false }, select: { name: true, isCurrent: true }, orderBy: { createdAt: 'desc' } }),
        prisma.schoolSettings.findFirst({ where: { schoolId }, select: { currentTerm: true, currentYear: true } }),
        store.getStorage(schoolId),
        ai.getUsage(req.user.userId),
    ]);
    res.status(StatusCodes.OK).json({
        config: cfg, classes, subjects, sessions, storage,
        curricula: [...cfg.customCurricula, ...ai.CURRICULA],
        currentTerm: settings?.currentTerm || null, currentYear: settings?.currentYear || null,
        ai: { configured: !!process.env.GEMINI_API_KEY, enabled: isAdmin(req) || cfg.teacherAiEnabled, usedToday: used, dailyLimit: isAdmin(req) ? null : cfg.teacherDailyAiLimit },
        canUpload: isAdmin(req) || cfg.teacherCanUpload, isAdmin: isAdmin(req),
    });
};

const saveConfig = async (req, res) => {
    const b = req.body || {};
    const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
    const cfg = ai.mergeConfig({
        ...b,
        weeksPerTerm: num(b.weeksPerTerm, 1, 30, 13), maxDiagrams: num(b.maxDiagrams, 0, 6, 2), teacherDailyAiLimit: num(b.teacherDailyAiLimit, 0, 500, 20),
        maxUploadMB: num(b.maxUploadMB, 1, 20, 10), fontSizePt: num(b.fontSizePt, 8, 18, 11),
        detailLevel: ['concise', 'standard', 'detailed'].includes(b.detailLevel) ? b.detailLevel : 'standard',
        pageSize: b.pageSize === 'Letter' ? 'Letter' : 'A4',
        lessonNoteSections: (Array.isArray(b.lessonNoteSections) ? b.lessonNoteSections : ai.DEFAULT_CONFIG.lessonNoteSections).map(String).map(s => s.trim()).filter(Boolean).slice(0, 25),
        customCurricula: (Array.isArray(b.customCurricula) ? b.customCurricula : []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 30),
    });
    const existing = await prisma.schoolSettings.findFirst({ where: { schoolId: req.user.schoolId } });
    if (existing) await prisma.schoolSettings.update({ where: { id: existing.id }, data: { lessonNoteConfig: cfg } });
    else await prisma.schoolSettings.create({ data: { schoolId: req.user.schoolId, lessonNoteConfig: cfg } });
    await invalidateCache(`tenant_${req.user.schoolId}_settings`);
    res.status(StatusCodes.OK).json({ msg: 'Settings saved', config: cfg });
};

// ─── library ─────────────────────────────────────────────────────────────────
const listDocs = async (req, res) => {
    const { docType, term, week, sessionName, classId, subjectId, q, source, scope } = req.query;
    const where = {
        schoolId: req.user.schoolId, isDeleted: false,
        ...(!(isAdmin(req) && scope === 'all') && { ownerUserId: req.user.userId }),
        ...(docType && { docType: { in: String(docType).split(',') } }),
        ...(term && { term }), ...(week && { week: Number(week) }), ...(sessionName && { sessionName }),
        ...(classId && { classId }), ...(subjectId && { subjectId }), ...(source && { source }),
        ...(q && { OR: [{ title: { contains: String(q), mode: 'insensitive' } }, { subjectName: { contains: String(q), mode: 'insensitive' } }, { className: { contains: String(q), mode: 'insensitive' } }] }),
    };
    const docs = await prisma.academicDocument.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 300 });
    res.status(StatusCodes.OK).json({ documents: docs.map(d => ({ ...withoutContent(d), periodLabel: periodLabel(d) })) });
};

const getDoc = async (req, res) => {
    const doc = await findDoc(req, req.params.id);
    res.status(StatusCodes.OK).json({ document: { ...doc, periodLabel: periodLabel(doc) } });
};

const createDoc = async (req, res) => {
    const cfg = await loadConfig(req.user.schoolId);
    const week = validateMeta(req.body, cfg);
    const source = req.body.source === 'AI' ? 'AI' : 'MANUAL';
    const html = ai.sanitize(req.body.contentHtml || '');
    const size = Buffer.byteLength(html, 'utf8');
    try { await store.assertCapacity(req.user.schoolId, size); } catch (e) { wrapStatus(e); }

    const owner = await prisma.user.findUnique({ where: { id: req.user.userId }, select: { name: true } });
    const doc = await prisma.academicDocument.create({
        data: { schoolId: req.user.schoolId, ownerUserId: req.user.userId, ownerName: owner?.name || null, source, contentHtml: html, sizeBytes: size, ...metaFields(req.body, week) },
    });
    res.status(StatusCodes.CREATED).json({ msg: 'Saved', document: { ...withoutContent(doc), periodLabel: periodLabel(doc) } });
};

const updateDoc = async (req, res) => {
    const doc = await findDoc(req, req.params.id);
    const cfg = await loadConfig(req.user.schoolId);
    const merged = { ...doc, ...req.body, title: req.body.title ?? doc.title, docType: req.body.docType ?? doc.docType };
    const week = validateMeta(merged, cfg);
    const data = metaFields(merged, week);
    if (doc.source !== 'UPLOAD' && req.body.contentHtml !== undefined) {
        const html = ai.sanitize(req.body.contentHtml);
        const size = Buffer.byteLength(html, 'utf8');
        try { await store.assertCapacity(req.user.schoolId, size, doc.sizeBytes); } catch (e) { wrapStatus(e); }
        Object.assign(data, { contentHtml: html, sizeBytes: size });
    }
    const updated = await prisma.academicDocument.update({ where: { id: doc.id }, data });
    res.status(StatusCodes.OK).json({ msg: 'Saved', document: { ...withoutContent(updated), periodLabel: periodLabel(updated) } });
};

const deleteDoc = async (req, res) => {
    const doc = await findDoc(req, req.params.id);
    await prisma.academicDocument.update({ where: { id: doc.id }, data: { isDeleted: true, deletedAt: new Date() } });
    await store.deleteFile(doc.filePublicId);
    res.status(StatusCodes.OK).json({ msg: 'Deleted' });
};

// ─── upload an existing PDF / Word file ──────────────────────────────────────
const uploadDoc = async (req, res) => {
    const cfg = await loadConfig(req.user.schoolId);
    if (!isAdmin(req) && !cfg.teacherCanUpload) throw new CustomError.UnauthorizedError('Uploads are turned off for teachers in the lesson note settings');
    const file = req.files?.file;
    if (!file) throw new CustomError.BadRequestError('Choose a PDF or Word file to upload');
    if (!store.UPLOAD_TYPES[file.mimetype]) throw new CustomError.BadRequestError('Only PDF and Word (.doc, .docx) files can be uploaded');
    if (file.size > cfg.maxUploadMB * store.MB) throw new CustomError.BadRequestError(`File is too large. The limit is ${cfg.maxUploadMB} MB per file.`);

    const meta = { ...req.body, title: req.body.title || file.name.replace(/\.[^.]+$/, '') };
    const week = validateMeta(meta, cfg);
    try { await store.assertCapacity(req.user.schoolId, file.size); } catch (e) { wrapStatus(e); }

    const up = await store.uploadFile(file, req.user.schoolId);
    const owner = await prisma.user.findUnique({ where: { id: req.user.userId }, select: { name: true } });
    const doc = await prisma.academicDocument.create({
        data: {
            schoolId: req.user.schoolId, ownerUserId: req.user.userId, ownerName: owner?.name || null, source: 'UPLOAD',
            fileUrl: up.url, filePublicId: up.publicId, fileName: file.name, mimeType: file.mimetype, sizeBytes: file.size, ...metaFields(meta, week),
        },
    });
    res.status(StatusCodes.CREATED).json({ msg: 'File stored', document: { ...withoutContent(doc), periodLabel: periodLabel(doc) } });
};

// ─── AI generation ───────────────────────────────────────────────────────────
const generate = async (req, res) => {
    const cfg = await loadConfig(req.user.schoolId);
    if (!isAdmin(req)) {
        if (!cfg.teacherAiEnabled) throw new CustomError.UnauthorizedError('AI generation is turned off for teachers in the lesson note settings');
        if ((await ai.getUsage(req.user.userId)) >= cfg.teacherDailyAiLimit) throw new CustomError.BadRequestError(`You have reached today's limit of ${cfg.teacherDailyAiLimit} AI generations. Try again tomorrow or write it manually.`);
    }
    try {
        const out = await ai.generateDocument(req.body || {}, cfg);
        await ai.bumpUsage(req.user.userId);
        res.status(StatusCodes.OK).json(out);
    } catch (e) {
        if (e.status === 400) throw new CustomError.BadRequestError(e.message);
        console.error('[academic-docs] generate failed:', e.message);
        res.status(e.status || 502).json({ msg: e.message });
    }
};

// ─── export / download ───────────────────────────────────────────────────────
const sendFile = (res, { buffer, contentType, extension }, name) => {
    const safe = String(name || 'document').replace(/[^\w\- ]+/g, '_').slice(0, 80);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.${extension}"`);
    res.status(StatusCodes.OK).end(buffer);
};

/** The document as bytes in the requested format. Uploaded files come back as the original upload. */
const renderDoc = async (doc, schoolId, format) => {
    if (doc.source === 'UPLOAD') {
        const ext = store.UPLOAD_TYPES[doc.mimeType];
        return { buffer: await store.downloadFile(doc), contentType: doc.mimeType, extension: ext };
    }
    const [cfg, school] = await Promise.all([loadConfig(schoolId), loadSchool(schoolId)]);
    return exportDocument({ doc, school, cfg, format });
};

const exportSaved = async (req, res) => {
    const doc = await findDoc(req, req.params.id);
    const out = await renderDoc(doc, req.user.schoolId, req.query.format || 'pdf').catch(e => { throw e.status ? new CustomError.BadRequestError(e.message) : e; });
    sendFile(res, out, doc.title);
};

// Download what is on screen right now (even if not saved yet)
const exportDraft = async (req, res) => {
    const b = req.body || {};
    const doc = { title: b.title || 'Document', docType: ai.DOC_TYPES.includes(b.docType) ? b.docType : 'CUSTOM', contentHtml: ai.sanitize(b.contentHtml || ''), term: b.term, week: b.week || null, sessionName: b.sessionName, className: b.className, subjectName: b.subjectName, curriculum: b.curriculum };
    const [cfg, school] = await Promise.all([loadConfig(req.user.schoolId), loadSchool(req.user.schoolId)]);
    sendFile(res, await exportDocument({ doc, school, cfg, format: b.format || 'pdf' }), doc.title);
};

const downloadOriginal = async (req, res) => {
    const doc = await findDoc(req, req.params.id);
    if (doc.source !== 'UPLOAD') throw new CustomError.BadRequestError('This document was not uploaded as a file');
    const buffer = await store.downloadFile(doc);
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${(doc.fileName || 'document').replace(/"/g, '')}"`);
    res.status(StatusCodes.OK).end(buffer);
};

// ─── sharing ─────────────────────────────────────────────────────────────────
const shareEmail = async (req, res) => {
    const doc = await findDoc(req, req.params.id);
    const to = [...new Set((Array.isArray(req.body.to) ? req.body.to : String(req.body.to || '').split(/[,\s;]+/)).map(s => s.trim()).filter(Boolean))];
    if (!to.length) throw new CustomError.BadRequestError('Enter at least one email address');
    if (to.length > 10) throw new CustomError.BadRequestError('You can email up to 10 people at once');
    const bad = to.find(e => !EMAIL_RE.test(e));
    if (bad) throw new CustomError.BadRequestError(`"${bad}" is not a valid email address`);

    const format = req.body.format === 'docx' ? 'docx' : 'pdf';
    const file = await renderDoc(doc, req.user.schoolId, format);
    const [school, sender] = await Promise.all([loadSchool(req.user.schoolId), prisma.user.findUnique({ where: { id: req.user.userId }, select: { name: true, email: true } })]);
    const schoolName = school?.schoolName || 'School';
    const note = String(req.body.message || '').slice(0, 1000).replace(/[<>]/g, '');
    try {
        const transporter = await getTransporter(req.user.schoolId);
        await transporter.sendMail({
            from: await getFromEmail(req.user.schoolId), to, replyTo: sender?.email, subject: `${doc.title}${periodLabel(doc) ? ` — ${periodLabel(doc)}` : ''}`,
            html: `<div style="font-family:sans-serif"><p>${note ? note.replace(/\n/g, '<br/>') : `${sender?.name || 'A teacher'} shared a ${DOC_LABEL[doc.docType] || 'document'} with you.`}</p><p><strong>${doc.title}</strong>${periodLabel(doc) ? `<br/>${periodLabel(doc)}` : ''}</p><p style="color:#888;font-size:12px">Sent from ${schoolName} via Skooly</p></div>`,
            attachments: [{ filename: `${doc.title.replace(/[^\w\- ]+/g, '_').slice(0, 80)}.${file.extension}`, content: file.buffer, contentType: file.contentType }],
        });
    } catch (e) {
        console.error('[academic-docs] email failed:', e.message);
        throw new CustomError.BadRequestError('The email could not be sent. Check the school\'s email (SMTP) settings.');
    }
    res.status(StatusCodes.OK).json({ msg: `Sent to ${to.length} recipient${to.length === 1 ? '' : 's'}` });
};

// A time-limited public link — used for WhatsApp (and anything else that can't take an attachment)
const createShareLink = async (req, res) => {
    const doc = await findDoc(req, req.params.id);
    const format = req.body.format === 'docx' ? 'docx' : 'pdf';
    const days = Math.min(30, Math.max(1, Number(req.body.days) || 7));
    const token = jwt.sign({ docId: doc.id, schoolId: doc.schoolId, format, purpose: 'academic-share' }, process.env.JWT_SECRET, { expiresIn: `${days}d` });
    const base = `${req.protocol}://${req.get('host')}`;
    res.status(StatusCodes.OK).json({ url: `${base}/api/v1/academic-docs/public/${token}`, expiresInDays: days, title: doc.title, periodLabel: periodLabel(doc) });
};

const publicDownload = async (req, res) => {
    let p;
    try { p = jwt.verify(req.params.token, process.env.JWT_SECRET); } catch { throw new CustomError.UnauthenticatedError('This link has expired or is invalid'); }
    if (p.purpose !== 'academic-share') throw new CustomError.UnauthenticatedError('This link is invalid');
    const doc = await prisma.academicDocument.findFirst({ where: { id: p.docId, schoolId: p.schoolId, isDeleted: false } });
    if (!doc) throw new CustomError.NotFoundError('This document is no longer available');
    sendFile(res, await renderDoc(doc, p.schoolId, p.format), doc.title);
};

module.exports = {
    getMeta, saveConfig, listDocs, getDoc, createDoc, updateDoc, deleteDoc, uploadDoc, generate,
    exportSaved, exportDraft, downloadOriginal, shareEmail, createShareLink, publicDownload,
};
