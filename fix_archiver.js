const fs = require('fs');
let file = fs.readFileSync('controllers/result.controller.js', 'utf-8');
file = file.replace(
    /const archiver = archiverModule.default \|\| archiverModule;\s*const archive = archiver\('zip', \{ zlib: \{ level: 9 \} \}\);/,
    `let archive;
            if (archiverModule.ZipArchive) {
                 archive = new archiverModule.ZipArchive({ zlib: { level: 9 } });
            } else {
                 const archiver = archiverModule.default || archiverModule;
                 archive = archiver('zip', { zlib: { level: 9 } });
            }`
);
fs.writeFileSync('controllers/result.controller.js', file);
