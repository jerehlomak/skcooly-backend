const puppeteer = require('puppeteer');

(async () => {
    try {
        const browser = await puppeteer.launch({headless: 'new'});
        const page = await browser.newPage();
        
        page.on('console', msg => console.log('PAGE LOG:', msg.text()));
        page.on('pageerror', err => console.log('PAGE ERROR:', err.toString()));
        page.on('requestfailed', request => console.log('REQ FAILED:', request.url(), request.failure().errorText));
        
        // Use a test token if possible, but let's just see if it crashes before that
        console.log('Navigating...');
        await page.goto('http://localhost:5173/print-batch?studentIds=1&classId=2&term=First&academicYear=2023/2024&token=invalid', {waitUntil: 'networkidle2'});
        
        console.log('Waiting for #print-ready...');
        await page.waitForSelector('#print-ready', { timeout: 10000 });
        console.log('SUCCESS');
        
        await browser.close();
    } catch(e) {
        console.error('PUP ERROR:', e.message);
        process.exit(1);
    }
})();
