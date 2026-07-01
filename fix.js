const fs = require('fs');
let file = fs.readFileSync('controllers/result.controller.js', 'utf-8');
const appendText = `// ─── BATCH CACHE FOR BULK PRINT ────────────────────────────────────────────────
const crypto = require('crypto');
const batchCache = new Map();

const getBatchIds = async (req, res) => {
    const { batchId } = req.params;
    const ids = batchCache.get(batchId);
    if (!ids) {
        return res.status(404).json({ msg: 'Batch not found or expired' });
    }
    res.status(200).json({ studentIds: ids });
};

const batchExportPDF = async (req, res) => {
    const { studentIds, classId, term, academicYear, templateId, format } = req.body;
    
    if (!studentIds || !Array.isArray(studentIds) || studentIds.length === 0) {
        throw new CustomError.BadRequestError('No students selected for export');
    }

    const frontendUrl = req.headers.origin || process.env.FRONTEND_URL || 'http://localhost:5173';
    
    const token = jwt.sign(
        { userId: req.user.userId, schoolId: req.user.schoolId, role: req.user.role },
        process.env.JWT_SECRET,
        { expiresIn: '30m' }
    );

    try {
        if (format === 'zip') {
            const jobs = studentIds.map(studentId => ({
                filename: \`Result_\${studentId}.pdf\`,
                url: \`\${frontendUrl}/print-batch?studentIds=\${studentId}&classId=\${classId}&term=\${encodeURIComponent(term)}&academicYear=\${encodeURIComponent(academicYear)}&templateId=\${templateId || ''}&resultType=\${req.body.resultType || 'FULL'}&token=\${token}\`
            }));

            const pdfs = await generateDynamicPDFs(jobs);

            const archiverModule = await import('archiver');
            let archive;
            if (archiverModule.ZipArchive) {
                 archive = new archiverModule.ZipArchive({ zlib: { level: 9 } });
            } else {
                 const archiver = archiverModule.default || archiverModule;
                 archive = archiver('zip', { zlib: { level: 9 } });
            }
            res.attachment(\`results_\${classId}.zip\`);
            archive.pipe(res);

            pdfs.forEach(pdfObj => {
                if (pdfObj && pdfObj.buffer) archive.append(pdfObj.buffer, { name: pdfObj.filename });
            });

            await archive.finalize();

        } else {
            const batchId = crypto.randomBytes(16).toString('hex');
            batchCache.set(batchId, studentIds);
            setTimeout(() => batchCache.delete(batchId), 10 * 60 * 1000);

            const url = \`\${frontendUrl}/print-batch?batchId=\${batchId}&classId=\${classId}&term=\${encodeURIComponent(term)}&academicYear=\${encodeURIComponent(academicYear)}&templateId=\${templateId || ''}&resultType=\${req.body.resultType || 'FULL'}&token=\${token}\`;
            
            const pdfBuffer = await generateDynamicPDF(url);

            res.set({
                'Content-Type': 'application/pdf',
                'Content-Disposition': \`attachment; filename="Class_Results.pdf"\`,
                'Content-Length': pdfBuffer.length,
            });
            res.end(pdfBuffer);
        }
    } catch (error) {
        console.error("Batch Export Error:", error);
        res.status(500).json({ msg: 'Failed to generate batch export' });
    }
};

module.exports = {
    getBatchIds,
    batchExportPDF,
`;
file = file.replace(/module\.exports\s*=\s*\{/, appendText);
fs.writeFileSync('controllers/result.controller.js', file);
