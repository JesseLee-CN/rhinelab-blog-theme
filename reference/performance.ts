// 上游 51ba3b0 / 65fc700 的基准页脚本，**按本站 scene 接口改写**（上游版本用到
// setPlayfield / setRhythmStyle / revealImmediately / uiOnlyParallax 等本站没有的音乐与
// HUD 接口）。场景集合相应收敛为 idle / static / navigate / detail / inspect；
// 选择、主题、画质、模型精度替换与计量逻辑与上游保持一致。
//
// 用法：npm run dev:reference 后打开 /reference/performance.html
//       ?precision=high|medium|low 切换模型精度；页面暴露 window.bench 供脚本采样。
import { ArchiveScene } from '../src/scene';
import { qualityPresets } from '../src/render-quality';

// Fixed random kernel makes before/after SSAO comparisons reproducible.
let seed = 431;
Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const scene = new ArchiveScene(document.querySelector('#scene')!);
await scene.load();
const precision = new URLSearchParams(location.search).get('precision') || (window as any).__precisionTier;
const geometry = precision && ['high', 'medium', 'low'].includes(precision)
  ? await (await import('./model-precision')).applyPrecision(scene, precision as any) : null;
scene.setQuality(qualityPresets.original);
scene.setMode('archive');
scene.select(0);
let time = 100;
const gl = scene.renderer.getContext() as WebGL2RenderingContext;
const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
const internal = scene as any;
let uploads = 0, uploadBytes = 0;
const bufferSubData = gl.bufferSubData.bind(gl);
gl.bufferSubData = ((...args: any[]) => {
  uploads++;
  uploadBytes += args[4] ? args[4] * (args[2].BYTES_PER_ELEMENT || 1) : args[2].byteLength;
  return (bufferSubData as any)(...args);
}) as any;
const step = (cinema?: any) => { time += 1 / 60; scene.update(time, cinema); };
Object.assign(window, { bench: {
  scene,
  async prepare(name: string, options: any = {}) {
    scene.setTheme(!!options.dark, true);
    scene.setQuality({ ...qualityPresets.original, ...options.quality });
    scene.setReduced(name === 'static');
    scene.setMode(name === 'detail' || name === 'inspect' ? 'detail' : 'archive');
    if (name === 'inspect') internal.targetRotation = 0;
    // Advance springs without expensive draws, then render real warm-up frames.
    const render = internal.composer.render;
    internal.composer.render = () => {};
    for (let i = 0; i < 1200; i++) step();
    internal.composer.render = render;
    // A resize invalidates the reused-frame cache, so the first real frame draws.
    scene.resize();
    for (let i = 0; i < 8; i++) step();
    gl.finish();
  },
  async sample(name: string, count = 48) {
    const samples: any[] = [];
    for (let i = 0; i < count; i++) {
      if (name === 'navigate' && i % 12 === 0) scene.select((i / 12 + 1) % 8);
      if (name === 'inspect') internal.targetRotation = .45 * Math.sin(i * .055);
      const query = ext ? gl.createQuery() : null;
      uploads = uploadBytes = 0;
      if (query) gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      const start = performance.now();
      step();
      const cpu = performance.now() - start;
      if (query) gl.endQuery(ext.TIME_ELAPSED_EXT, query);
      gl.finish();
      const total = performance.now() - start;
      await new Promise(r => setTimeout(r, 0));
      let gpu: number | null = null;
      if (query) {
        for (let attempts = 0; attempts < 100 && !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE); attempts++) await new Promise(r => setTimeout(r, 1));
        if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(ext.GPU_DISJOINT_EXT)) gpu = gl.getQueryParameter(query, gl.QUERY_RESULT)/1e6;
        gl.deleteQuery(query);
      }
      samples.push({cpu,total,gpu,uploads,uploadBytes,calls:scene.renderer.info.render.calls,triangles:scene.renderer.info.render.triangles});
    }
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return {samples, geometry, stats:scene.getStats(), quality:document.querySelector('#scene')!.getAttribute('data-render-quality'),renderer:debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),gpuTimer:!!ext};
  },
  draw() { step(); gl.finish(); },
} });
