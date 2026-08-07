import { chromium } from 'playwright';
const browser = await chromium.launch({
  args: ['--use-gl=angle','--use-angle=metal','--enable-unsafe-webgpu','--ignore-gpu-blocklist','--enable-gpu-rasterization']
});
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
const info = await page.evaluate(() => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  if (!gl) return { webgl2: false };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    webgl2: true,
    vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxSamples: gl.getParameter(gl.MAX_SAMPLES),
    colorBufferFloat: !!gl.getExtension('EXT_color_buffer_float'),
    texFloatLinear: !!gl.getExtension('OES_texture_float_linear'),
    aniso: !!gl.getExtension('EXT_texture_filter_anisotropic'),
    astc: !!gl.getExtension('WEBGL_compressed_texture_astc'),
    s3tc: !!gl.getExtension('WEBGL_compressed_texture_s3tc'),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
