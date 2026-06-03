const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, 'public');
const files = fs.readdirSync(publicDir).filter(f => f.endsWith('.html'));

files.forEach(file => {
    const filePath = path.join(publicDir, file);
    let html = fs.readFileSync(filePath, 'utf8');

    // Remove max-w-* and mx-auto and paddings from main tag
    html = html.replace(/<main class="([^"]*)max-w-[a-z0-9]+([^"]*)">/g, '<main class="$1$2">');
    html = html.replace(/<main class="([^"]*)mx-auto([^"]*)">/g, '<main class="$1$2">');
    // Remove px-*, py-*, pb-* from main
    html = html.replace(/<main class="([^"]*)px-\d+([^"]*)">/g, '<main class="$1$2">');
    html = html.replace(/<main class="([^"]*)sm:px-\d+([^"]*)">/g, '<main class="$1$2">');
    html = html.replace(/<main class="([^"]*)py-\d+([^"]*)">/g, '<main class="$1$2">');
    html = html.replace(/<main class="([^"]*)sm:py-\d+([^"]*)">/g, '<main class="$1$2">');
    html = html.replace(/<main class="([^"]*)pb-\d+([^"]*)">/g, '<main class="$1$2">');
    html = html.replace(/<main class="([^"]*)sm:pb-\d+([^"]*)">/g, '<main class="$1$2">');
    html = html.replace(/<main class="([^"]*)pt-\d+([^"]*)">/g, '<main class="$1$2">');
    html = html.replace(/<main class="([^"]*)sm:pt-\d+([^"]*)">/g, '<main class="$1$2">');

    // Clean up multiple spaces in main class
    html = html.replace(/<main class="([^"]*)">/g, (match, p1) => `<main class="${p1.replace(/\s+/g, ' ').trim()}">`);

    // In the main div, remove rounded corners and shadows that make it look like a floating card
    // The main container typically has glass-panel rounded-3xl or rounded-2xl or rounded-xl
    // We want to replace these with full width, no rounded corners.
    // We'll just regex replace 'rounded-3xl', 'rounded-2xl', 'rounded-xl', 'rounded-lg' if they appear alongside glass-panel in the main layout.
    // Actually, just removing rounded-* and shadow-* from the first div inside main is safest, but we can just do a broad replace of "glass-panel rounded-..." if we identify the main wrapper.

    // Let's do it by finding <div class="glass-panel rounded-3xl ..."> or similar and removing rounded-3xl and shadow-md.
    html = html.replace(/class="([^"]*)glass-panel rounded-3xl([^"]*)"/g, 'class="$1bg-white$2"');
    html = html.replace(/class="([^"]*)glass-panel rounded-2xl([^"]*)"/g, 'class="$1bg-white$2"');
    html = html.replace(/class="([^"]*)glass-panel rounded-xl([^"]*)"/g, 'class="$1bg-white$2"');
    // Also remove shadow-md from these
    html = html.replace(/class="([^"]*)bg-white shadow-md([^"]*)"/g, 'class="$1bg-white$2"');
    
    // Some forms in index.html use glass-panel rounded-xl sm:rounded-2xl
    html = html.replace(/class="([^"]*)glass-panel([^"]*)"/g, 'class="$1bg-white$2"');
    html = html.replace(/class="([^"]*)rounded-3xl([^"]*)"/g, 'class="$1$2"');

    // Remove the banner/header padding/margin that causes space
    html = html.replace(/<div class="relative py-4 sm:py-8 px-4 sm:px-6/g, '<div class="relative py-8 px-4 sm:px-8');

    fs.writeFileSync(filePath, html, 'utf8');
});

console.log('Spaces and card-styles removed from main layouts!');
