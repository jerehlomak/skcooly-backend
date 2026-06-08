const puppeteer = require('puppeteer');

(async () => {
    try {
        const browser = await puppeteer.launch({ headless: 'new' });
        console.log('Puppeteer launched successfully!');
        await browser.close();
    } catch (e) {
        console.error('Puppeteer failed:', e);
    }
})();
