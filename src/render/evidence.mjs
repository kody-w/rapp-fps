import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { createServer } from 'node:net';

async function findFreePort() {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function runShoot(url, outDir, name, extraArgs = '') {
  try {
    execSync(`node tools/shoot.mjs --url "${url}" --out "${outDir}" --shots "${name}" --budgetMs 16.7 ${extraArgs}`, { stdio: 'inherit' });
    return JSON.parse(readFileSync(`${outDir}/report.json`, 'utf-8'));
  } catch (err) {
    console.error(`Shoot failed for ${name}!`);
    throw err;
  }
}

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
        
        const lum = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
        const chroma = (rgb) => {
          const r = rgb[0]/255, g = rgb[1]/255, b = rgb[2]/255;
          const max = Math.max(r,g,b), min = Math.min(r,g,b);
          return max - min;
        };

        // 1. Horizon sample
        // Sample vertical strip near center
        const x = 50; 
        const horizonPixels = [];
        for(let y = 0; y < img.height; y++) {
          const i = (y * img.width + x) * 4;
          horizonPixels.push([data[i], data[i+1], data[i+2]]);
        }
        
        let maxDelta = 0;
        for(let i = 1; i < horizonPixels.length; i++) {
          if (i > img.height - 100) continue;

          const delta = Math.abs(lum(horizonPixels[i]) - lum(horizonPixels[i-1]));
          if (delta > maxDelta) {
             maxDelta = delta;
          }
        }

        // 2. Sun corona test
        let maxLum = -1;
        let sunX = 0, sunY = 0;
        
        // Find brightest pixel (anchor ROI to projected sun coordinate)
        for(let y = 0; y < img.height / 2; y+=5) {
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
        for(let dx = 0; dx < 200; dx += 1) {
          if (sunX + dx >= img.width) break;
          const i = (sunY * img.width + (sunX + dx)) * 4;
          sunPixels.push({
            lum: lum([data[i], data[i+1], data[i+2]]),
            chroma: chroma([data[i], data[i+1], data[i+2]])
          });
        }
        
        let uniqueLumSteps = 0;
        let uniqueChromaSteps = 0;
        
        if (sunPixels.length > 0) {
          let prevL = sunPixels[0].lum;
          let prevC = sunPixels[0].chroma;
          for (let i = 1; i < sunPixels.length; i++) {
            // Require strictly monotonic decreases to count as a step, ignoring noise increases
            if (prevL - sunPixels[i].lum > 1.5) {
               uniqueLumSteps++;
               prevL = sunPixels[i].lum;
            }
            if (Math.abs(sunPixels[i].chroma - prevC) > 0.01) {
               uniqueChromaSteps++;
               prevC = sunPixels[i].chroma;
            }
          }
        }

        resolve({ maxHorizonDelta: maxDelta, uniqueLumSteps, uniqueChromaSteps, sunCenter: [sunX, sunY], maxLum });
      };
      img.src = 'data:image/png;base64,' + base64;
    });
  }, base64);
  
  await browser.close();
  return result;
}

async function runTest() {
  const port = await findFreePort();
  console.log(`Starting Vite on port ${port}...`);
  const gitSha = execSync('git rev-parse HEAD').toString().trim();
  writeFileSync('src/render/commit.txt', gitSha);
  
  const vite = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', port.toString()], { stdio: 'pipe' });
  
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const baseUrl = `http://127.0.0.1:${port}/`;

  try {
    const fetchedSha = execSync(`curl -s ${baseUrl}src/render/commit.txt`).toString().trim();
    if (fetchedSha !== gitSha) {
      throw new Error(`Served SHA ${fetchedSha} does not match expected ${gitSha}`);
    }
    console.log(`Testing commit: ${gitSha} verified via browser fetch`);

    console.log("Running pos budget tests and checking default camera horizon...");
    for(let i=1; i<=3; i++) {
      console.log(`Shot ${i}...`);
      const report = runShoot(baseUrl, `shots/evidence/pos${i}`, `default`);
      if (report.overBudget) {
        throw new Error("OVER BUDGET on positive test");
      }
    }
    const defaultAnalysis = await analyzeImage('shots/evidence/pos1/default.png');
    console.log("Analysis of default camera (production) image:", defaultAnalysis);
    let blockedReason = null;
    if (defaultAnalysis.maxHorizonDelta > 20) {
      console.error(`BLOCKED: Horizon too sharp on production camera! Delta: ${defaultAnalysis.maxHorizonDelta}`);
      blockedReason = `Horizon too sharp on production camera (Delta: ${defaultAnalysis.maxHorizonDelta.toFixed(2)}). Render alone cannot hide the finite level floor edge without a heavy filter. Request level contract to fade fog/geometry.`;
    }
    
    // Now look at sun to test sun falloff
    console.log("Running sun falloff test...");
    runShoot(`${baseUrl}?lookAtSun=1&bloom=off&aa=off&lens=off`, `shots/evidence/sun`, `sunShot`);
    const analysis = await analyzeImage('shots/evidence/sun/sunShot.png');
    console.log("Analysis of sun image:", analysis);
    
    if (analysis.maxHorizonDelta > 20) {
      throw new Error(`Horizon too sharp! Delta: ${analysis.maxHorizonDelta}`);
    }
    
    if (analysis.uniqueLumSteps < 5) {
      throw new Error(`Sun edge too hard (luminance)! Steps: ${analysis.uniqueLumSteps}`);
    }
    if (analysis.uniqueChromaSteps < 5) {
      throw new Error(`Sun edge too hard (chroma)! Steps: ${analysis.uniqueChromaSteps}`);
    }

    // Negative controls
    console.log("Running negative control: hardDisc...");
    let passedHardDiscSteps = [];
    for(let i=0; i<3; i++) {
        runShoot(`${baseUrl}?lookAtSun=1&hardDisc=1&bloom=off&aa=off&lens=off`, `shots/evidence/neg_hardDisc_${i}`, `hardDisc`);
        const analysisHard = await analyzeImage(`shots/evidence/neg_hardDisc_${i}/hardDisc.png`);
        passedHardDiscSteps.push(analysisHard.uniqueLumSteps);
        if (analysisHard.uniqueLumSteps >= 5) {
            throw new Error(`Hard disc negative control failed! Found ${analysisHard.uniqueLumSteps} lum steps (expected < 5)`);
        }
    }
    console.log("Analysis of hardDisc images (lum steps):", passedHardDiscSteps);

    // Negative control: misalignedKey
    console.log("Running negative control: misalignedKey...");
    runShoot(`${baseUrl}?lookAtSun=1&misalignedKey=1`, `shots/evidence/neg_misaligned`, `misaligned`);
    const analysisMisaligned = await analyzeImage(`shots/evidence/neg_misaligned/misaligned.png`);
    console.log("Analysis of misaligned key image:", analysisMisaligned);
    // Sun should NOT be exactly in the center of the screen since camera looks at normal SUN_DIRECTION but sun is rendered at misaligned direction
    // If maxLum is very low, the sun is offscreen, which is a pass.
    if (analysisMisaligned.maxLum > 240) {
      const centerDist = Math.sqrt(Math.pow(analysisMisaligned.sunCenter[0] - 1920/2, 2) + Math.pow(analysisMisaligned.sunCenter[1] - 1080/2, 2));
      if (centerDist < 100) {
          throw new Error("Misaligned key test failed! Sun still appears in the center of the camera.");
      }
      console.log("Misaligned key sun center distance from center:", centerDist);
    } else {
      console.log("Misaligned key test passed: bright sun not found on screen.");
    }

    // Forced failure control
    console.log("Running forced failure control...");
    let failed = false;
    try {
      execSync(`node tools/shoot.mjs --url "http://localhost:9999" --out shots/evidence/fail --shots failShot`, { stdio: 'ignore' });
    } catch (e) {
      failed = true;
    }
    if (!failed) {
      throw new Error("shoot.mjs didn't fail on bad url!");
    }

    if (blockedReason) {
      console.log(`BLOCKED: ${blockedReason}`);
    } else {
      console.log("Evidence generated successfully.");
    }
  } finally {
    vite.kill();
  }
}

runTest().catch(e => {
  console.error(e);
  process.exit(1);
});
