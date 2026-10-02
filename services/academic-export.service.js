const puppeteer = require('puppeteer');
const axios = require('axios');
const HTMLtoDOCX = require('html-to-docx');
const { sanitize } = require('./academic-ai.service');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const DOC_LABEL = { LESSON_NOTE: 'Lesson Note', LESSON_PLAN: 'Lesson Plan', SCHEME_OF_WORK: 'Scheme of Work', CURRICULUM: 'Curriculum', CUSTOM: 'Document' };

/** "Week 5 · First Term · 2026/2027" — the term/week stamp shown on every saved or exported document. */
const periodLabel = (d) => [d.week ? `Week ${d.week}` : null, d.term, d.sessionName].filter(Boolean).join(' · ');

// ─── shared browser (launching Chrome per export is slow) ────────────────────
let browserPromise = null;
const getBrowser = () => {
    if (!browserPromise) {
        browserPromise = puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] })
            .catch(e => { browserPromise = null; throw e; });
        browserPromise.then(b => b.on('disconnected', () => { browserPromise = null; })).catch(() => {});
    }
    return browserPromise;
};

const toDataUrl = async (url) => {
    if (!url) return null;
    if (url.startsWith('data:')) return url;
    try {
        const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000 });
        return `data:${r.headers['content-type'] || 'image/png'};base64,${Buffer.from(r.data).toString('base64')}`;
    } catch { return null; }
};

const letterhead = async (school, cfg) => {
    if (!cfg.includeLetterhead) return '';
    const logo = await toDataUrl(school?.logoUrl);
    return `<table style="width:100%;border:none;border-collapse:collapse;margin-bottom:6px"><tr>
        ${logo ? `<td style="width:70px;border:none;vertical-align:middle"><img src="${logo}" width="64" height="64" alt="" /></td>` : ''}
        <td style="border:none;text-align:${logo ? 'left' : 'center'};vertical-align:middle">
            <div style="font-size:18pt;font-weight:bold">${esc(school?.schoolName || '')}</div>
            ${school?.arabicName ? `<div dir="rtl" style="font-size:13pt">${esc(school.arabicName)}</div>` : ''}
            ${cfg.letterheadText ? `<div style="font-size:9pt;color:#555">${esc(cfg.letterheadText)}</div>` : school?.address ? `<div style="font-size:9pt;color:#555">${esc(school.address)}</div>` : ''}
        </td></tr></table><hr style="border:0;border-top:2px solid #333;margin:4px 0 10px" />`;
};

const metaLine = (d) => {
    const bits = [DOC_LABEL[d.docType], d.className, d.subjectName, d.curriculum].filter(Boolean);
    const stamp = periodLabel(d);
    return `<p style="font-size:9.5pt;color:#444;margin:0 0 10px">${stamp ? `<strong>${esc(stamp)}</strong>` : ''}${stamp && bits.length ? ' &nbsp;|&nbsp; ' : ''}${esc(bits.join(' · '))}</p>`;
};

/** Full printable HTML for a document (letterhead + term/week stamp + body). */
const buildDocumentHtml = async ({ doc, school, cfg }) => {
    const body = sanitize(doc.contentHtml || '');
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(doc.title)}</title><style>
        body{font-family:${esc(cfg.fontFamily)},Helvetica,sans-serif;font-size:${Number(cfg.fontSizePt) || 11}pt;color:#111;line-height:1.45}
        h1{font-size:19pt;margin:6px 0 8px} h2{font-size:14.5pt;margin:14px 0 6px;border-bottom:1px solid #ccc;padding-bottom:2px} h3{font-size:12pt;margin:10px 0 4px}
        table{border-collapse:collapse;width:100%;margin:8px 0} td,th{border:1px solid #555;padding:4px 6px;vertical-align:top} th{background:#e8edf7;text-align:left}
        figure{margin:10px 0;text-align:center;page-break-inside:avoid} figcaption{font-size:9pt;color:#555} svg,img{max-width:100%;height:auto} tr{page-break-inside:avoid}
    </style></head><body>${await letterhead(school, cfg)}${metaLine(doc)}${body}${cfg.footerText ? `<p style="margin-top:18px;font-size:9pt;color:#666;text-align:center">${esc(cfg.footerText)}</p>` : ''}</body></html>`;
};

const toPdf = async (html, cfg, title) => {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
        await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
        return Buffer.from(await page.pdf({
            format: cfg.pageSize === 'Letter' ? 'Letter' : 'A4', printBackground: true, margin: { top: '16mm', bottom: '18mm', left: '15mm', right: '15mm' },
            displayHeaderFooter: true, headerTemplate: '<span></span>',
            footerTemplate: `<div style="width:100%;font-size:8px;color:#777;text-align:center"><span>${esc((title || '').slice(0, 80))}</span> &nbsp;·&nbsp; Page <span class="pageNumber"></span> / <span class="totalPages"></span></div>`,
        }));
    } finally { await page.close().catch(() => {}); }
};

/** Word can't render inline SVG, so rasterise each <svg> to a PNG <img> first. */
const rasteriseSvgs = async (html) => {
    const svgs = html.match(/<svg[\s\S]*?<\/svg>/g);
    if (!svgs) return html;
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
        let out = html;
        for (const svg of svgs) {
            const vb = svg.match(/viewBox="([d.s,-]+)"/);
            const nums = vb ? vb[1].trim().split(/[s,]+/).map(Number) : [];
            const vw = nums[2] > 0 ? nums[2] : 640, vh = nums[3] > 0 ? nums[3] : 400;
            const width = Math.min(Math.max(vw, 200), 1000), height = Math.round(width * vh / vw);
            const sized = svg.replace(/<svg([^>]*?)>/, (m, attrs) => `<svg${attrs.replace(/\s(width|height)="[^"]*"/g, '')} width="${width}" height="${height}">`);
            await page.setViewport({ width, height, deviceScaleFactor: 2 });
            await page.setContent(`<body style="margin:0;background:#fff">${sized}</body>`);
            const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height } });
            out = out.replace(svg, `<img src="data:image/png;base64,${Buffer.from(png).toString('base64')}" width="${Math.min(width, 560)}" height="${Math.round(Math.min(width, 560) * height / width)}" alt="diagram" />`);
        }
        return out;
    } finally { await page.close().catch(() => {}); }
};

/** Natural size of a PNG / JPEG / GIF data URL (so Word gets the right aspect ratio). */
const imageSize = (src) => {
    try {
        const m = /^data:image\/(png|jpe?g|gif);base64,(.+)$/i.exec(src || '');
        if (!m) return null;
        const b = Buffer.from(m[2].slice(0, 400000), 'base64');
        if (m[1].toLowerCase() === 'png') return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
        if (m[1].toLowerCase() === 'gif') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
        for (let i = 2; i < b.length - 9;) { // JPEG: walk segments to the SOF marker
            if (b[i] !== 0xff) { i++; continue; }
            const mk = b[i + 1];
            if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
            i += 2 + b.readUInt16BE(i + 2);
        }
    } catch { /* fall through */ }
    return null;
};

const toDocx = async (html, cfg, doc) => {
    const withImages = await rasteriseSvgs(html);
    // Word needs borders spelled out inline; give images without a size a sensible one
    const ready = sanitize(withImages.replace(/<body[^>]*>|<\/body>|<\/?html>|<head>[\s\S]*?<\/head>|<!doctype[^>]*>/gi, ''), {
        transformTags: {
            table: (t, a) => ({ tagName: t, attribs: { ...a, style: `${a.style || ''};border-collapse:collapse;width:100%` } }),
            td: (t, a) => ({ tagName: t, attribs: { ...a, style: `${a.style || ''};border:1px solid #555;padding:4px` } }),
            th: (t, a) => ({ tagName: t, attribs: { ...a, style: `${a.style || ''};border:1px solid #555;padding:4px;background-color:#e8edf7` } }),
            img: (t, a) => {
                const nat = imageSize(a.src) || { w: 480, h: 320 };
                const w = Math.min(Number(a.width) || nat.w, 560);
                const h = a.width && a.height ? Math.round(w * Number(a.height) / Number(a.width)) : Math.round(w * nat.h / nat.w);
                return { tagName: t, attribs: { ...a, width: String(w), height: String(h) } };
            },
        },
    });
    const buf = await HTMLtoDOCX(`<div>${ready}</div>`, null, {
        table: { row: { cantSplit: true } }, footer: !!cfg.footerText, pageNumber: true,
        pageSize: cfg.pageSize === 'Letter' ? { width: 12240, height: 15840 } : { width: 11906, height: 16838 },
        font: cfg.fontFamily || 'Arial', fontSize: Math.round((Number(cfg.fontSizePt) || 11) * 2),
        title: doc.title, creator: doc.ownerName || 'Skooly',
    }, cfg.footerText ? `<p style="text-align:center">${esc(cfg.footerText)}</p>` : undefined);
    return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
};

const MIME = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };

/** Renders a document to the requested format. Returns { buffer, contentType, extension }. */
const exportDocument = async ({ doc, school, cfg, format }) => {
    if (!['pdf', 'docx'].includes(format)) throw Object.assign(new Error('format must be pdf or docx'), { status: 400 });
    const html = await buildDocumentHtml({ doc, school, cfg });
    const buffer = format === 'pdf' ? await toPdf(html, cfg, doc.title) : await toDocx(html, cfg, doc);
    return { buffer, contentType: MIME[format], extension: format };
};

module.exports = { exportDocument, periodLabel, DOC_LABEL, getBrowser, letterhead, esc };
