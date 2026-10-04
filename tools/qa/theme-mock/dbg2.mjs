import { serve } from './render.mjs';
const server = await serve(4175);
const html = await (await fetch('http://localhost:4175/')).text();
const m = html.match(/data-lair-config>([\s\S]*?)<\/script>/);
console.log(m ? m[1].slice(0, 700) : 'no config');
server.close();
