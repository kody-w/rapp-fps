import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

async function analyzeImage(imagePath) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const imgBuffer = readFileSync(imagePath);
  const base64 = imgBuffer.toString('base64');
  
  const result = await page.evaluate((base64) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d', { colorSpace: 'srgb' });
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, img.width, img.height).data;
        
        // 1. Horizon sample
        // Sample vertical strip near left edge to avoid floor objects
        const x = 50; 
        const horizonPixels = [];
        for(let y = 0; y < img.height; y++) {
          const i = (y * img.width + x) * 4;
          horizonPixels.push([data[i], data[i+1], data[i+2]]);
        }
        
        const lum = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
        let maxDelta = 0;
        let deltaLoc = 0;
        for(let i = 1; i < horizonPixels.length; i++) {
          const delta = Math.abs(lum(horizonPixels[i]) - lum(horizonPixels[i-1]));
          if (delta > maxDelta) {
             maxDelta = delta;
             deltaLoc = i;
          }
        }

        // 2. Sun corona test
        let maxLum = 0;
        let sunX = 0, sunY = 0;
        for(let y = 0; y < img.height; y+=5) {
          for(let dx = 0; dx < img.width; dx+=5) {
            const i = (y * img.width + dx) * 4;
            const l = lum([data[i], data[i+1], data[i+2]]);
            if (l > maxLum) {
              maxLum = l;
              sunX = dx;
              sunY = y;
            }
          }
        }
        
        const sunPixels = [];
        for(let dx = 0; dx < 200; dx += 10) {
          const i = (sunY * img.width + (sunX + dx)) * 4;
          sunPixels.push([data[i], data[i+1], data[i+2], lum([data[i], data[i+1], data[i+2]])]);
        }
        
        let uniqueSteps = 0;
        let prevL = sunPixels[0][3];
        for (let i = 1; i < sunPixels.length; i++) {
          if (Math.abs(sunPixels[i][3] - prevL) > 2) {
             uniqueSteps++;
             prevL = sunPixels[i][3];
          }
        }

        resolve({ maxHorizonDelta: maxDelta, uniqueSunSteps: uniqueSteps, sunCenter: [sunX, sunY], horizonDeltaY: deltaLoc });
      };
      img.src = 'data:image/png;base64,' + base64;
    });
  }, base64);
  
  await browser.close();
  return result;
}

async function runTest() {
  console.log("Running positive tests...");
  const results = [];
  for(let i=1; i<=3; i++) {
    console.log(`Shot ${i}...`);
    execSync(`node tools/shoot.mjs --out shots/evidence/pos${i} --budgetMs 16.7`);
    const report = JSON.parse(readFileSync(`shots/evidence/pos${i}/report.json`, 'utf-8'));
    results.push(report);
  }
  
  if (results.some(r => r.overBudget)) {
    console.error("OVER BUDGET");
    process.exit(1);
  } else {
    console.log("All 3 captures under budget.");
  }
  
  const analysis = await analyzeImage('shots/evidence/pos1/default.png');
  console.log("Analysis of positive image:", analysis);
  
  if (analysis.maxHorizonDelta > 20) {
    console.error("Horizon too sharp!");
    process.exit(1);
  } else {
    console.log("Horizon is smooth. Max delta:", analysis.maxHorizonDelta.toFixed(2), "< 20 threshold");
  }
  
  if (analysis.uniqueSunSteps < 5) {
    console.error("Sun edge too hard!");
    process.exit(1);
  } else {
    console.log("Sun has smooth roll-off. Unique steps:", analysis.uniqueSunSteps, ">= 5 threshold");
  }
  
  console.log("Evidence generated successfully.");
}

runTest().catch(console.error);
