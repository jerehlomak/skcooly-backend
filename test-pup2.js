const puppeteer = require('puppeteer');

(async () => {
    try {
        const browser = await puppeteer.launch({ headless: 'new' });
        const page = await browser.newPage();
        const url = 'http://localhost:5173'; // just test if we can hit it
        console.log('Navigating to', url);
        await page.goto(url, { waitUntil: 'networkidle2' });
        console.log('Success hitting frontend!');
        await browser.close();
    } catch (e) {
        console.error('Puppeteer failed:', e);
    }
})();
