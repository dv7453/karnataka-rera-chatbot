/**
 * Quick script to fetch the RERA page and inspect its HTML structure.
 */
const httpScraper = require('./httpScraper');
const fs = require('fs');
const path = require('path');

async function inspect() {
  console.log('Fetching RERA main page...');
  const session = await httpScraper.getSession();
  
  // Save raw HTML for inspection
  const htmlPath = path.join(__dirname, '..', 'debug_page.html');
  fs.writeFileSync(htmlPath, session.html);
  console.log(`Saved ${session.html.length} bytes to ${htmlPath}`);
  console.log(`Session ID: ${session.jsessionid}`);
  
  // Look for table-like structures
  const cheerio = require('cheerio');
  const $ = cheerio.load(session.html);
  
  console.log('\n--- Tables found ---');
  $('table').each((i, table) => {
    const $t = $(table);
    const id = $t.attr('id') || '(no id)';
    const cls = $t.attr('class') || '(no class)';
    const rows = $t.find('tr').length;
    const headers = [];
    $t.find('th').each((_, th) => headers.push($(th).text().trim().slice(0, 30)));
    console.log(`Table ${i}: id="${id}" class="${cls}" rows=${rows}`);
    if (headers.length > 0) console.log(`  Headers: ${headers.join(' | ')}`);
    
    // Show first data row
    const firstTr = $t.find('tbody tr, tr').eq(1);
    if (firstTr.length) {
      const cells = [];
      firstTr.find('td').each((_, td) => cells.push($(td).text().trim().slice(0, 40)));
      if (cells.length > 0) console.log(`  First row: ${cells.join(' | ')}`);
    }
  });
  
  console.log('\n--- Form elements ---');
  $('form').each((i, form) => {
    const $f = $(form);
    const action = $f.attr('action') || '(no action)';
    const method = $f.attr('method') || '(no method)';
    console.log(`Form ${i}: action="${action}" method="${method}"`);
  });
  
  console.log('\n--- Select dropdowns ---');
  $('select').each((i, sel) => {
    const $s = $(sel);
    const name = $s.attr('name') || $s.attr('id') || '(unnamed)';
    const optCount = $s.find('option').length;
    console.log(`Select: name="${name}" options=${optCount}`);
    // Show first 3 options
    $s.find('option').slice(0, 3).each((_, opt) => {
      console.log(`  - "${$(opt).text().trim()}" value="${$(opt).attr('value') || ''}"`);
    });
  });
  
  console.log('\n--- Looking for project data patterns ---');
  // Check for angular/react data attributes
  const bodyText = $('body').text().slice(0, 500);
  console.log('Body text start:', bodyText.slice(0, 200));
  
  // Look for divs with project-like classes
  const projectDivs = $('[class*="project"], [class*="result"], [class*="card"], [class*="list"]');
  console.log(`\nDivs with project/result/card/list classes: ${projectDivs.length}`);
  projectDivs.slice(0, 5).each((i, el) => {
    console.log(`  ${el.tagName}.${$(el).attr('class')}`);
  });
  
  // Look for ng- attributes (AngularJS)
  const ngElements = $('[ng-repeat], [ng-bind], [ng-model], [data-ng-repeat]');
  console.log(`\nAngularJS elements: ${ngElements.length}`);
  ngElements.slice(0, 5).each((i, el) => {
    const attrs = el.attribs;
    const relevant = Object.keys(attrs).filter(k => k.startsWith('ng-') || k.startsWith('data-ng-'));
    console.log(`  <${el.tagName}> ${relevant.map(k => `${k}="${attrs[k]}"`).join(' ')}`);
  });

  // Look for script tags with API endpoints
  console.log('\n--- Script tags with URLs ---');
  $('script').each((i, script) => {
    const src = $(script).attr('src') || '';
    const text = $(script).html() || '';
    if (src) console.log(`  Script src: ${src}`);
    
    // Look for API URLs in inline scripts
    const urlMatches = text.match(/(\/api\/|\/rest\/|\/search|\/project|ajax|fetch|XMLHttpRequest|\.json)/gi);
    if (urlMatches) {
      console.log(`  Inline script has: ${[...new Set(urlMatches)].join(', ')}`);
      // Extract URL patterns
      const urlPatterns = text.match(/['"](\/?[a-zA-Z][\w\/]*(?:Search|project|api|list|get|fetch)[\w\/]*)['"]/gi);
      if (urlPatterns) {
        urlPatterns.slice(0, 5).forEach(u => console.log(`    URL: ${u}`));
      }
    }
  });
}

inspect().catch(console.error);
