// plan() decides the output geometry. It is pure, so it can be checked here
// rather than by rendering clips.
import { plan } from '../src/core/video.js';

let pass = 0, fail = 0;
const check = (n, c, extra) => { c ? (pass++, console.log('  ok  ' + n)) : (fail++, console.log('  FAIL ' + n + (extra ? ' :: ' + extra : ''))); };

const landscape = { width: 1280, height: 720, duration: 10 };
const portrait = { width: 720, height: 1280, duration: 10 };

let p = plan(landscape, []);
check('no operations keeps the source size', p.width === 1280 && p.height === 720, `${p.width}x${p.height}`);
check('no trim keeps the full duration', p.duration === 10, String(p.duration));

p = plan(landscape, [{ type: 'rotate_video', params: { degrees: 90 } }]);
check('a quarter turn swaps the dimensions', p.width === 720 && p.height === 1280, `${p.width}x${p.height}`);

p = plan(landscape, [{ type: 'rotate_video', params: { degrees: 180 } }]);
check('a half turn keeps the dimensions', p.width === 1280 && p.height === 720, `${p.width}x${p.height}`);

p = plan(landscape, [
  { type: 'rotate_video', params: { degrees: 90 } },
  { type: 'rotate_video', params: { degrees: 90 } },
]);
check('two quarter turns come back to landscape', p.width === 1280 && p.height === 720, `${p.width}x${p.height}`);
check('two quarter turns record 180 degrees', p.rotation === 180, String(p.rotation));

// Smart orientation: rotate only what needs rotating.
p = plan(landscape, [{ type: 'set_orientation', params: { orientation: 'portrait' } }]);
check('landscape asked for portrait is turned', p.width === 720 && p.height === 1280, `${p.width}x${p.height}`);
check('and the turn is recorded', p.rotation === 90, String(p.rotation));

p = plan(portrait, [{ type: 'set_orientation', params: { orientation: 'portrait' } }]);
check('portrait asked for portrait is left alone', p.rotation === 0 && p.width === 720, `${p.width}x${p.height} rot=${p.rotation}`);

p = plan(portrait, [{ type: 'set_orientation', params: { orientation: 'landscape' } }]);
check('portrait asked for landscape is turned', p.width === 1280 && p.height === 720, `${p.width}x${p.height}`);

// Trim
p = plan(landscape, [{ type: 'trim_video', params: { start: 2, end: 7 } }]);
check('trim sets the start', p.start === 2, String(p.start));
check('trim sets the duration', p.duration === 5, String(p.duration));

p = plan(landscape, [{ type: 'trim_video', params: { start: 0, end: 99 } }]);
check('a trim past the end is clamped', p.duration === 10, String(p.duration));

p = plan(landscape, [{ type: 'trim_video', params: { start: -5, end: 4 } }]);
check('a negative start is clamped to zero', p.start === 0 && p.duration === 4, `${p.start}/${p.duration}`);

// Resize
p = plan(landscape, [{ type: 'resize_video', params: { max_width: 640 } }]);
check('resize scales both axes', p.width === 640 && p.height === 360, `${p.width}x${p.height}`);

p = plan(landscape, [{ type: 'resize_video', params: { max_width: 4000 } }]);
check('resize never enlarges', p.width === 1280, String(p.width));

// Encoders reject odd dimensions.
p = plan({ width: 1281, height: 721, duration: 5 }, []);
check('odd dimensions are made even', p.width % 2 === 0 && p.height % 2 === 0, `${p.width}x${p.height}`);

p = plan({ width: 1001, height: 999, duration: 5 }, [{ type: 'resize_video', params: { max_width: 501 } }]);
check('dimensions stay even after resizing', p.width % 2 === 0 && p.height % 2 === 0, `${p.width}x${p.height}`);

// Combined
p = plan(landscape, [
  { type: 'rotate_video', params: { degrees: 90 } },
  { type: 'resize_video', params: { max_width: 360 } },
  { type: 'trim_video', params: { start: 1, end: 4 } },
]);
check('rotate, resize and trim combine', p.width === 360 && p.height === 640 && p.duration === 3,
      `${p.width}x${p.height} ${p.duration}s`);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
