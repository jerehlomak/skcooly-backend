const fs = require('fs');
const path = require('path');

const controllersDir = path.join(__dirname, 'controllers');
const files = fs.readdirSync(controllersDir).filter(f => f.endsWith('.js'));

for (const file of files) {
    const filePath = path.join(controllersDir, file);
    let content = fs.readFileSync(filePath, 'utf8');

    // Regex to remove `const { PrismaClient } = require('@prisma/client')`
    content = content.replace(/const\s*{\s*PrismaClient\s*}\s*=\s*require\('@prisma\/client'\);?/g, '');

    // Regex to replace `const prisma = new PrismaClient()` with `const prisma = require('../db/prisma');`
    content = content.replace(/const\s+prisma\s*=\s*new\s+PrismaClient\(\);?/g, "const prisma = require('../db/prisma');");

    fs.writeFileSync(filePath, content, 'utf8');
}

// App.js
const appJsPath = path.join(__dirname, 'app.js');
let appJsContent = fs.readFileSync(appJsPath, 'utf8');
appJsContent = appJsContent.replace(/const\s*{\s*PrismaClient\s*}\s*=\s*require\('@prisma\/client'\);?/g, '');
appJsContent = appJsContent.replace(/const\s+prisma\s*=\s*new\s+PrismaClient\(\);?/g, "const prisma = require('./db/prisma');");
fs.writeFileSync(appJsPath, appJsContent, 'utf8');

console.log('Refactored all files to use single prisma instance.');
