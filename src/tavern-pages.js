// Round 34b, the Tavern's two screens (contract v34-tavern, section 4a): the order page at the table and the staff's
// drinks list with its recipe cards and its ring. They follow the canvas "Tavern ordering: phone screens" (Mo, 19 Nov
// 2026: colour, each drink as a little drawing, the fancy name on top with the plain name under it, animated).
//
// The Lair serves both through the store's app proxy (www.dicegoblin.nz/apps/liar/tavern and .../tavern/drinks), so
// Shopify still says who's logged in and the theme needs nothing but a link or a QR card. Each is one page with nothing
// about anyone in it: it asks the Lair's own routes (src/tavern.js) for the menu, the orders and the list, and the Lair
// decides every price and who may see what.
//
// The pages' code is written here as ordinary functions and sent as text (fn.toString()), so each one may only use
// what's inside itself or handed to it: nothing from this file's scope.

/**
 * How each drink is drawn: its colour, its topping's colour and its kind of drawing, and the sign of its name that
 * bursts out of it when the straw stirs (Mo, 20 Nov 2026: a heart with a plus for Healing, blue energy for Mana, a
 * lightning bolt for Haste, and so on), in its own colour.
 */
export const TAVERN_LOOKS = {
  'strawberry-lemonade': { sign: 'heart', sc: '#ff4d6d', c: '#ff8fa3', p: '#e0304f', art: 'fizz' },
  'blue-lychee': { sign: 'star', sc: '#4db8ff', c: '#5ec8f2', p: '#f6d34b', art: 'fizz' },
  'passionfruit-mango': { sign: 'bolt', sc: '#ffd23f', c: '#ffb347', p: '#ff7a1a', art: 'fizz' },
  'peach-grapefruit': { sign: 'clover', sc: '#46d06c', c: '#ff9e80', p: '#ffd0ad', art: 'fizz' },
  'taro-milk': { sign: 'moon', sc: '#c9a6ff', c: '#b79ae8', p: '#6b3f1d', art: 'cream' },
  'strawberry-milk': { sign: 'charm', sc: '#ff7eb6', c: '#ffb3c7', p: '#e0304f', art: 'cream' },
  'honeydew-milk': { sign: 'drop', sc: '#5fd38a', c: '#b8e986', p: '#ff7a1a', art: 'cream' },
  'brown-sugar-milk-tea': { sign: 'strength', sc: '#e0a060', c: '#c9976b', p: '#6b3f1d', art: 'cream' },
  'thai-milk-tea': { sign: 'flame', sc: '#ff7a1a', c: '#e8894a', p: '#6b3f1d', art: 'cream' },
  'strawberry-matcha': { sign: 'spiral', sc: '#b98cff', c: '#ffb3c7', c2: '#9fce6e', p: '#e0304f', art: 'layer' },
  'cookies-cream-shake': { sign: 'shield', sc: '#b9c0c8', c: '#e9dcc9', p: '#3a2a20', art: 'shake' },
  'mango-slushy': { sign: 'snow', sc: '#9be7ff', c: '#ffc94d', p: '#ff7a1a', art: 'slush' },
  'brew-your-own': { sign: 'flask', sc: '#c9a6ff', c: '#c9a6ff', c2: '#5ec8f2', p: '#f6d34b', art: 'layer' },
  coffee: { sign: 'wind', sc: '#f8efe2', c: '#8a5a3c', art: 'hot' },
  'hot-chocolate': { sign: 'sun', sc: '#ffb347', c: '#6b3f1d', art: 'hot' },
  tea: { sign: 'eye', sc: '#ffd98a', c: '#c98a3c', art: 'hot' },
  pukka: { sign: 'leaf', sc: '#8fd16a', c: '#9fce6e', art: 'hot' },
};

const CSS = `
:root{color-scheme:dark;--bg:#16110f;--panel:#221b17;--line:#4d3d34;--cream:#f8efe2;--ink:#16110f;--muted:#c4b5a5;--soft:#5e5853;--gold:#f6b93b;--gold-edge:#b8821c;--go:#46d06c;--go-edge:#2a8f47;--edge:#7b7065;--warn:#9a3412;--rule:#ddd0bf;--tint:#c4b5a5}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;min-height:100dvh;background-color:var(--bg);background-image:linear-gradient(rgba(248,239,226,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(248,239,226,.035) 1px,transparent 1px);background-size:24px 24px;color:var(--cream);font:16px/1.45 Poppins,system-ui,-apple-system,"Segoe UI",sans-serif}
h1,h2,h3,p{margin:0}
.fancy{font-family:"Rammetto One",Poppins,system-ui,sans-serif;font-weight:400}
a{color:var(--gold)}
button,input{font:inherit}
button{font-weight:600;border:0;border-radius:999px;cursor:pointer;color:inherit;-webkit-tap-highlight-color:transparent;touch-action:manipulation}
button:disabled{opacity:.45;cursor:default}
:focus-visible{outline:3px solid var(--gold);outline-offset:2px}
[hidden]{display:none!important}
.page{max-width:480px;margin:0 auto;padding:20px 16px 132px;display:flex;flex-direction:column;gap:10px}
.staff .page{padding-bottom:32px;gap:14px}
.top{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 12px}
.top h1{font-size:34px;line-height:1;color:var(--gold)}
.top h1 small{display:block;font-size:15px;line-height:1.3;color:var(--cream)}
.staff .top h1{font-size:26px;line-height:1.1;color:var(--cream)}
.pill{background:var(--gold);color:var(--ink);font-weight:700;font-size:14px;border-radius:999px;padding:6px 14px;white-space:nowrap}
.pill.small{padding:2px 12px}
.muted{color:var(--muted);font-size:14px}
.small{font-size:13px}
.notice{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:10px 14px;font-size:14px}
.notice.gold{background:var(--gold);color:var(--ink);border:0;border-bottom:4px solid var(--gold-edge);font-weight:600;font-size:15px}
.tier{display:flex;align-items:center;gap:10px;margin-top:6px}
.tier h2{font-size:22px;color:var(--tier,var(--cream))}
.tier i{width:14px;height:14px;background:var(--tier,var(--cream));transform:rotate(45deg);border-radius:3px;flex:none}
.card{background:var(--cream);color:var(--ink);border-radius:18px;border-bottom:5px solid var(--c,var(--tint));padding:10px 12px 10px 10px;display:flex;align-items:center;gap:12px}
.card.resting{opacity:.55}
.art{width:64px;height:76px;border-radius:14px;background:color-mix(in srgb,var(--c,var(--tint)) 33%,transparent);display:flex;align-items:center;justify-content:center;flex:none}
.art.big{width:84px;height:96px;border-radius:18px;background:var(--cream);border-bottom:5px solid var(--c,var(--tint))}
.art.mini{width:44px;height:52px;border-radius:12px}
.art.plain{background:var(--cream)}
.card .words{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.card .fancy{font-size:18px;line-height:1.15}
.plainname{font-weight:600;font-size:14px;line-height:1.3}
.plainname b,.no{color:var(--soft);font-weight:600}
.chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px;padding-top:6px;border-top:1px dashed #cdbfae}
.chips span{background:color-mix(in srgb,var(--c,var(--tint)) 33%,transparent);border-radius:999px;padding:1px 9px;font-size:13px}
.chips .caf{background:transparent;box-shadow:inset 0 0 0 1.5px var(--soft);color:var(--soft)}
.plus{width:44px;height:44px;background:var(--go);color:var(--ink);border-bottom:4px solid var(--go-edge);display:flex;align-items:center;justify-content:center;flex:none}
.added{min-width:44px;height:44px;padding:0 14px;background:var(--ink);color:var(--cream);font-size:15px;flex:none;white-space:nowrap}
.go{background:var(--go);color:var(--ink);border-bottom:5px solid var(--go-edge)}
.ghost{background:transparent;color:var(--cream);box-shadow:inset 0 0 0 1.5px var(--edge)}
.bar{position:fixed;left:0;right:0;bottom:0;background:var(--panel);border-top:1px solid var(--line);z-index:5}
.bar .in{max-width:480px;margin:0 auto;padding:12px 16px calc(16px + env(safe-area-inset-bottom,0px));display:flex;align-items:center;gap:12px}
.bar .sum{flex:1;min-width:0;background:none;border-radius:8px;text-align:left;padding:0;font-weight:400}
.bar .sum strong{display:block;font-weight:700;font-size:17px;font-variant-numeric:tabular-nums}
.bar .order{height:50px;padding:0 28px;font-size:16px;flex:none}
.say{max-width:480px;margin:0 auto;padding:10px 16px 0;font-size:14px;color:var(--gold);font-weight:600}
.sheet{position:fixed;inset:0;z-index:10;background:var(--bg);overflow-y:auto;overscroll-behavior:contain;animation:tv-up .22s ease-out}
.sheet .crumb{max-width:480px;margin:0 auto;padding:14px 16px 8px;display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--muted);font-size:14px}
.sheet .crumb button{height:44px;padding:0 14px;font-size:14px}
.sheet .body{max-width:480px;margin:0 auto;min-height:calc(100dvh - 66px);background:var(--panel);border-radius:22px 22px 0 0;border-top:1px solid var(--line);padding:20px 16px calc(16px + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;gap:10px}
.head{display:flex;align-items:center;gap:14px}
.head h1{font-size:28px;line-height:1.1;color:var(--c,var(--cream))}
.head .plainname{font-size:16px;margin-top:4px}
.head .plainname b{color:var(--muted)}
.head .desc{color:var(--muted);font-size:14px;margin-top:6px;padding-top:6px;border-top:1px dashed var(--line)}
.head .desc b{color:var(--gold);font-weight:600}
.label{margin:8px 0 0;font-size:14px;font-weight:600;color:var(--muted)}
.picks{display:flex;flex-wrap:wrap;gap:8px}
.picks button{min-height:44px;padding:0 16px;font-size:14px;background:transparent;color:var(--cream);box-shadow:inset 0 0 0 1.5px var(--edge)}
.picks button[aria-pressed="true"]{background:var(--go);color:var(--ink);box-shadow:none;border-bottom:4px solid var(--go-edge)}
.tick{display:flex;align-items:center;gap:12px;min-height:46px;border-bottom:1px solid var(--line)}
.tick input{width:22px;height:22px;accent-color:var(--go);margin:0;flex:none}
.tick label{flex:1;font-size:15px;padding:11px 0}
.tick span{font-size:14px;font-weight:600;color:var(--muted);font-variant-numeric:tabular-nums}
.tick span.cost{color:var(--gold)}
.note{height:48px;border-radius:14px;border:1.5px solid var(--edge);background:var(--bg);color:var(--cream);padding:0 14px;width:100%;font-size:16px}
.grow{flex:1}
.wide{height:52px;width:100%;font-size:16px}
.line{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--line)}
.line:first-of-type{border-top:0}
.line .what{flex:1;min-width:0}
.line .what strong{display:block;font-size:15px;line-height:1.3}
.line .price{font-weight:600;font-variant-numeric:tabular-nums}
.line button{height:44px;padding:0 14px;font-size:14px}
.status{font-size:13px;font-weight:600;border-radius:999px;padding:2px 10px;white-space:nowrap;box-shadow:inset 0 0 0 1.5px var(--edge)}
.status.making{background:var(--gold);color:var(--ink);box-shadow:none}
.status.done{background:var(--go);color:var(--ink);box-shadow:none}
.status.cancelled{color:var(--muted);text-decoration:line-through}
.ringer{display:flex;align-items:center;gap:10px;border-radius:16px;padding:12px 14px;width:100%;text-align:left;font-size:15px;line-height:1.3}
.ringer.on{background:var(--gold);color:var(--ink);border-bottom:5px solid var(--gold-edge);font-weight:700}
.ringer .bell{display:flex}
.order{display:flex;flex-direction:column;gap:12px;border-radius:18px;padding:14px}
.order.new{background:var(--cream);color:var(--ink);border-bottom:5px solid var(--tint)}
.order.mine{background:var(--panel);border:1px solid var(--line);gap:10px}
.order .who{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.order .who strong{font-size:19px}
.order .who span{font-size:14px;font-variant-numeric:tabular-nums;color:var(--muted);text-align:right}
.order.new .who span{font-weight:600;color:var(--warn)}
.drink{display:flex;gap:10px;align-items:flex-start}
.order.mine .drink{align-items:center;min-height:56px;border-top:1px solid var(--line);padding-top:10px}
.drink .what{flex:1;min-width:0}
.drink .what strong{display:block;font-size:16px;line-height:1.3}
.order.mine .drink .what strong{font-size:15px;font-weight:600}
.drink .what small{display:block;font-size:13px;color:var(--soft)}
.order.mine .drink .what small,.order.mine .no{color:var(--muted)}
.drink .tag{margin-top:4px;display:inline-block;background:var(--gold);color:var(--ink);font-size:13px;font-weight:600;border-radius:999px;padding:2px 10px}
.drink button{height:44px;padding:0 14px;font-size:14px;flex:none}
.drink button.go{padding:0 18px;border-bottom-width:4px}
.goes{background:var(--cream);color:var(--ink);border-radius:18px;border-bottom:5px solid var(--tint);padding:12px 16px 8px}
.goes h2{font-size:14px;font-weight:600;color:var(--soft);margin-bottom:2px}
.goes div{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-top:1px solid var(--rule);font-size:15px}
.goes h2+div{border-top:0}
.goes div b{font-size:16px;font-weight:700;font-variant-numeric:tabular-nums;text-align:right}
.steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px;counter-reset:s}
.steps li{display:flex;gap:12px;align-items:flex-start;font-size:16px;line-height:1.4;counter-increment:s}
.steps li::before{content:counter(s);font-family:"Rammetto One",sans-serif;font-size:22px;line-height:1.1;color:var(--gold);width:26px;flex:none}
.rhead h1{font-size:30px;line-height:1.1;color:var(--cream)}
.rhead .fname{color:var(--c,var(--muted));font-size:14px;font-weight:600;margin-top:2px}
@keyframes tv-rise{0%{transform:translateY(0);opacity:0}15%{opacity:.95}100%{transform:translateY(-22px);opacity:0}}
@keyframes tv-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}
@keyframes tv-swirl{0%,100%{transform:translateX(-3px)}50%{transform:translateX(3px)}}
@keyframes tv-steam{0%{transform:translateY(2px);opacity:0}40%{opacity:.9}100%{transform:translateY(-5px);opacity:0}}
@keyframes tv-ring{0%,60%,100%{transform:rotate(0)}10%,30%,50%{transform:rotate(-14deg)}20%,40%{transform:rotate(14deg)}}
@keyframes tv-pulse{0%,100%{box-shadow:0 0 0 0 rgba(246,185,59,.75)}50%{box-shadow:0 0 0 7px rgba(246,185,59,0)}}
@keyframes tv-stir{0%,19%{transform:rotate(0)}22%{transform:rotate(-9deg)}25%{transform:rotate(8deg)}28%{transform:rotate(-7deg)}31%{transform:rotate(6deg)}34%,100%{transform:rotate(0)}}
@keyframes tv-burst{0%,31%{opacity:0;transform:scale(.15) rotate(-25deg)}35%{opacity:1;transform:scale(1.25) rotate(4deg)}39%{opacity:1;transform:scale(1)}52%{opacity:1;transform:scale(1.06)}58%,100%{opacity:0;transform:scale(1.6)}}
@keyframes tv-ringfx{0%,31%{opacity:0;transform:scale(.3)}34%{opacity:.9}46%,100%{opacity:0;transform:scale(1.7)}}
@keyframes tv-flash{0%,31%,46%,100%{filter:none}36%{filter:brightness(1.35) saturate(1.3)}}
@keyframes tv-up{from{transform:translateY(24px);opacity:0}to{transform:none;opacity:1}}
@keyframes tv-pop{0%{transform:scale(1)}40%{transform:scale(1.12)}100%{transform:scale(1)}}
.tv-bub{animation:tv-rise 2.4s linear infinite}.tv-b2{animation-delay:.8s}.tv-b3{animation-delay:1.6s}
.tv-pearl{animation:tv-bob 2.8s ease-in-out infinite}.tv-p2{animation-delay:.5s}.tv-p3{animation-delay:1s}
.tv-swirl{animation:tv-swirl 4s ease-in-out infinite}
.tv-steam{animation:tv-steam 2.6s ease-in-out infinite}
.ringer.on .bell{animation:tv-ring 1.6s ease-in-out infinite;transform-origin:50% 10%}
.ringer.on{animation:tv-pulse 1.6s ease-out infinite}
.mug{overflow:visible}
.tv-fx{opacity:0;transform-box:fill-box;transform-origin:center;pointer-events:none}
.tv-ringfx{transform-box:fill-box;transform-origin:center}
.tv-straw{transform-box:view-box;transform-origin:20px 36px}
.live .tv-straw{animation:tv-stir 8s ease-in-out infinite;animation-delay:var(--d,0s)}
.live .tv-fx{animation:tv-burst 8s ease-out infinite;animation-delay:var(--d,0s)}
.live .tv-ringfx{animation:tv-ringfx 8s ease-out infinite;animation-delay:var(--d,0s)}
.live .tv-liquid{animation:tv-flash 8s ease-out infinite;animation-delay:var(--d,0s)}
@media (prefers-reduced-motion:reduce){*,*::before{animation:none!important}}
`;

/* ------------------------------------------------------------------------------------------------------------------
   The pages' own code. Everything from here to the next rule runs in the phone's browser, not in the Lair.
   ------------------------------------------------------------------------------------------------------------------ */

/** What both pages share: building the page safely (text only, never HTML from the Lair), the drawings and the Lair's routes */
function tavernKit(LOOKS) {
  const SVG = 'http://www.w3.org/2000/svg';
  const put = (node, kids) => {
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  };
  const make = (ns) => (tag, attrs, ...kids) => {
    const node = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'on') for (const [event, fn] of Object.entries(value)) node.addEventListener(event, fn);
      else if (key === 'vars') for (const [name, v] of Object.entries(value)) node.style.setProperty(name, v);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    return put(node, kids);
  };
  const h = make(null);
  const s = make(SVG);
  // a QR card covers one table ("Table F1") or the tables next to each other ("Tables T4 & T5")
  const at = (id) => `${String(id).includes('&') ? 'Tables' : 'Table'} ${id}`;
  const money = (cents) => `$${cents % 100 ? (cents / 100).toFixed(2) : cents / 100}`;
  const look = (id) => LOOKS[id] || { c: '#c4b5a5', p: '#6b3f1d', art: 'cream' };

  // Each sign fits a 24 by 24 box: [path, how it's painted] (f filled in the sign's colour, s a line in it, w a white
  // line, wf filled white, k filled dark)
  const SIGNS = {
    heart: [['M12 20.5C5 15.5 3 12 3 8.8A4.8 4.8 0 0 1 12 6.6 4.8 4.8 0 0 1 21 8.8c0 3.2-2 6.7-9 11.7z', 'f'], ['M12 9.5v6M9 12.5h6', 'w']],
    star: [['M12 1.5l2.8 7.7 7.7 2.8-7.7 2.8L12 22.5l-2.8-7.7L1.5 12l7.7-2.8z', 'f'], ['M12 8.5l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z', 'wf']],
    bolt: [['M13.5 1.5 4.5 13.5h5.5L8.5 22.5l10-13h-5.5z', 'f']],
    clover: [['M12 12c-6-1-7-8-2.5-8.5C12 3.2 12 7 12 12zM12 12c1-6 8-7 8.5-2.5C20.8 12 17 12 12 12zM12 12c6 1 7 8 2.5 8.5C12 20.8 12 17 12 12zM12 12c-1 6-8 7-8.5 2.5C3.2 12 7 12 12 12z', 'f']],
    moon: [['M20 14.8A8.8 8.8 0 1 1 9.2 4a7 7 0 0 0 10.8 10.8z', 'f'], ['M15.5 3.5h4l-4 4.5h4', 'w']],
    charm: [['M12 20.5C5 15.5 3 12 3 8.8A4.8 4.8 0 0 1 12 6.6 4.8 4.8 0 0 1 21 8.8c0 3.2-2 6.7-9 11.7z', 'f'], ['M12 8.6l1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1z', 'wf']],
    drop: [['M12 2.5c4.2 5 6.8 8.3 6.8 12a6.8 6.8 0 0 1-13.6 0c0-3.7 2.6-7 6.8-12z', 'f'], ['M8.8 14.2l2.3 2.3 4.2-4.4', 'w']],
    strength: [['M2.5 9.5h3v5h-3zM18.5 9.5h3v5h-3zM5.5 7h3v10h-3zM15.5 7h3v10h-3zM8.5 10.8h7v2.4h-7z', 'f']],
    flame: [['M12 1.5c1 4.5 6.5 7 6.5 13a6.5 6.5 0 0 1-13 0c0-2.6 1.2-4.4 2.6-5.8.3 1.6 1.2 2.6 2 2.8C9.6 8 10.8 4.5 12 1.5z', 'f'], ['M12 12.5c.5 2 2.5 2.8 2.5 5a2.5 2.5 0 0 1-5 0c0-2 1.8-2.8 2.5-5z', 'wf']],
    spiral: [['M12 12.4a1.6 1.6 0 1 1 1.6-1.6 3.8 3.8 0 1 1-3.8 3.8 6.2 6.2 0 1 1 6.2 6.2', 's'], ['M4 3.5v3M2.5 5h3M20 16.5v3M18.5 18h3', 'w']],
    shield: [['M12 2l8.5 3v6.5c0 5-3.5 8.6-8.5 10.5-5-1.9-8.5-5.5-8.5-10.5V5z', 'f'], ['M12 5.2l5.5 2v4.3c0 3.3-2.2 5.8-5.5 7.2z', 'wf']],
    snow: [['M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7M12 5.500l-2-2M12 5.500l2-2M12 18.500l-2 2M12 18.500l2 2', 's']],
    flask: [['M9.5 2.500h5V4h-1v5l5.2 9.600a2 2 0 0 1-1.8 2.900H7.100a2 2 0 0 1-1.8-2.900L10.5 9V4h-1z', 'f'], ['M8.2 16h7.6', 'w']],
    wind: [['M2.5 9h10.500a3 3 0 1 0-3-3M2.5 13h16a3 3 0 1 1-3 3M2.5 17h7', 's']],
    sun: [['M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z', 'f'], ['M12 1.500v3M12 19.500v3M1.5 12h3M19.5 12h3M4.6 4.600l2.1 2.100M17.3 17.300l2.1 2.100M4.6 19.400l2.1-2.100M17.3 6.700l2.1-2.1', 's']],
    eye: [['M1.5 12s4-7 10.5-7 10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z', 'f'], ['M12 8.500a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z', 'wf'], ['M12 10.800a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.400z', 'k']],
    leaf: [['M4.5 19.500C3.5 10 9 3.5 20.5 3.500c0 11.5-6.5 17-16 16z', 'f'], ['M5 19l9-9', 'w']],
  };
  /** The burst: a glow, a ring, sparks and the sign of the drink's name, all in the sign's colour */
  function burst(k) {
    const ink = '#16110f';
    const fx = s('g', { class: 'tv-fx', 'aria-hidden': 'true' },
      s('circle', { cx: 21, cy: 24, r: 14, fill: k.sc, 'fill-opacity': 0.45 }),
      s('circle', { class: 'tv-ringfx', cx: 21, cy: 24, r: 13, fill: 'none', stroke: k.sc, 'stroke-width': 2 }));
    for (let n = 0; n < 8; n += 1) {
      const a = (n * Math.PI) / 4 + 0.4;
      fx.append(s('path', { d: `M${(21 + Math.cos(a) * 15.5).toFixed(1)} ${(24 + Math.sin(a) * 15.5).toFixed(1)}L${(21 + Math.cos(a) * 19.5).toFixed(1)} ${(24 + Math.sin(a) * 19.5).toFixed(1)}`, stroke: n % 2 ? '#fff' : k.sc, 'stroke-width': 2, 'stroke-linecap': 'round' }));
    }
    const sign = s('g', { transform: 'translate(9 12)' });
    for (const [d, how] of SIGNS[k.sign] || []) {
      if (how === 'f') sign.append(s('path', { d, fill: k.sc, stroke: ink, 'stroke-width': 1.4, 'stroke-linejoin': 'round' }));
      else if (how === 'wf') sign.append(s('path', { d, fill: '#fff', 'fill-opacity': 0.9 }));
      else if (how === 'k') sign.append(s('path', { d, fill: ink }));
      else {
        if (how === 's') sign.append(s('path', { d, fill: 'none', stroke: ink, 'stroke-width': 4.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
        sign.append(s('path', { d, fill: 'none', stroke: how === 's' ? k.sc : '#fff', 'stroke-width': how === 's' ? 2.4 : 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      }
    }
    fx.append(sign);
    return fx;
  }

  /**
   * A drink as a little drawing: a glass tavern mug (or a hot mug), filled its own colour, with its topping. With a
   * delay (seconds into its 8-second round, so the drinks on a page don't all go off together) it's alive: the bubbles
   * rise, the straw gives a little stir, and the sign of its name bursts out. Without one it's the quiet drawing.
   */
  function mug(id, label, width = 46, delay = null) {
    const k = look(id);
    const ink = '#16110f';
    const live = delay !== null && Boolean(k.sign);
    const svg = s('svg', { class: live ? 'mug live' : 'mug', role: 'img', 'aria-label': label, width, height: Math.round((width * 56) / 48), viewBox: '0 0 48 56' });
    if (live) svg.style.setProperty('--d', `${-delay}s`);
    if (k.art === 'hot') {
      put(svg, [
        s('path', { class: 'tv-steam', d: 'M16 12c-3-3 3-5 0-8', fill: 'none', stroke: '#f8efe2', 'stroke-width': 2, 'stroke-linecap': 'round' }),
        s('path', { class: 'tv-steam tv-b2', d: 'M24 12c-3-3 3-5 0-8', fill: 'none', stroke: '#f8efe2', 'stroke-width': 2, 'stroke-linecap': 'round' }),
        s('path', { d: 'M34 26h4a5 5 0 0 1 5 5v4a5 5 0 0 1-5 5h-4', fill: 'none', stroke: ink, 'stroke-width': 2.6 }),
        s('path', { d: 'M7 18h28v24a8 8 0 0 1-8 8H15a8 8 0 0 1-8-8z', fill: '#fffaf2', stroke: ink, 'stroke-width': 2.6, 'stroke-linejoin': 'round' }),
        s('path', { class: 'tv-liquid', d: 'M9.6 19.4h22.800v6.600H9.600z', fill: k.c }),
      ]);
      if (live) svg.append(burst(k));
      return svg;
    }
    put(svg, [
      s('path', { d: 'M34 21h4a5 5 0 0 1 5 5v8a5 5 0 0 1-5 5h-4', fill: 'none', stroke: ink, 'stroke-width': 2.6 }),
      s('rect', { x: 8, y: 10, width: 26, height: 40, rx: 5, fill: '#fffaf2', stroke: ink, 'stroke-width': 2.6 }),
      s('rect', { class: 'tv-liquid', x: 10.5, y: 17, width: 21, height: 30.5, rx: 3, fill: k.c }),
    ]);
    if (k.art === 'layer') svg.append(s('rect', { x: 10.5, y: 17, width: 21, height: 11, rx: 3, fill: k.c2 }));
    if (k.art === 'fizz') {
      for (const [n, x] of [15, 21, 27].entries()) {
        svg.append(s('circle', { class: `tv-bub${n ? ` tv-b${n + 1}` : ''}`, cx: x, cy: 38, r: 1.6, fill: 'none', stroke: '#fff', 'stroke-width': 1.3 }));
      }
    } else if (k.art === 'slush') {
      for (const [x, y] of [[14, 22], [20, 26], [27, 21], [24, 31], [15, 32]]) svg.append(s('path', { d: `M${x} ${y}l2.4-1.4 2.4 1.4-2.4 1.4z`, fill: '#fff', 'fill-opacity': 0.8 }));
    } else {
      svg.append(s('path', { class: 'tv-swirl', d: 'M13 26c4-3 7 3 11 0s5-2 6-1', fill: 'none', stroke: '#fff', 'stroke-opacity': 0.75, 'stroke-width': 2, 'stroke-linecap': 'round' }));
      if (k.art !== 'layer') svg.append(s('rect', { x: 10.5, y: 17, width: 21, height: 4, rx: 2, fill: '#fff8ee' }));
    }
    if (k.art === 'shake') {
      for (const [x, y] of [[14, 30], [19, 36], [26, 29], [28, 40], [15, 42], [22, 44]]) svg.append(s('circle', { cx: x, cy: y, r: 1.3, fill: k.p }));
    } else {
      const pearls = [[14.5, 43, ''], [21, 44, ' tv-p2'], [27.5, 43, ' tv-p3'], [17.5, 39.5, ' tv-p3'], [24.5, 39.5, '']];
      for (const [x, y, extra] of pearls) svg.append(s('circle', { class: `tv-pearl${extra}`, cx: x, cy: y, r: 2.6, fill: k.p, stroke: ink, 'stroke-width': 1 }));
    }
    svg.append(s('g', { class: 'tv-straw' },
      s('path', { d: 'M25 3 20 36', stroke: ink, 'stroke-width': 4.4, 'stroke-linecap': 'round' }),
      s('path', { d: 'M25 3 20 36', stroke: k.p, 'stroke-width': 2.2, 'stroke-linecap': 'round' })));
    if (live) svg.append(burst(k));
    return svg;
  }

  // The page sits at <the store's link to the Lair>/tavern, and the Lair's routes sit beside it
  const base = location.pathname.replace(/\/(tavern|apothecary)(\/drinks)?\/?$/, '');
  async function lair(method, path, body) {
    let res;
    try {
      res = await fetch(`${base}/${path}`, {
        method, credentials: 'same-origin', cache: 'no-store',
        headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      return { status: 0, data: { error: "That didn't get through. Check your signal and try again." } };
    }
    const data = await res.json().catch(() => ({ error: "Something went wrong at our end. Try again, or order at the counter." }));
    return { status: res.status, data };
  }
  // the store's own log-in, which comes back to this page (as the staff page's does)
  const loginUrl = () => `/customer_authentication/login?return_to=${encodeURIComponent(location.pathname + location.search)}`;
  return { h, s, put, money, look, mug, lair, loginUrl, base, at };
}

/** The order page at the table */
function tavernOrderPage(kit) {
  const { h, s, money, look, mug, lair, loginUrl, at } = kit;
  const root = document.getElementById('app');
  const code = (new URLSearchParams(location.search).get('t') || '').trim().toUpperCase();
  const KEEP = `tavern-order-${code}`;
  const brand = () => h('h1', { class: 'fancy' }, h('small', null, "Goblin's"), 'Apothecary');
  let drawn = 0;
  const state = { menu: null, lines: [], member: null, mine: [], sheet: null, say: '', busy: false, justOrdered: null, failed: false };
  try {
    const kept = JSON.parse(sessionStorage.getItem(KEEP) || '[]');
    if (Array.isArray(kept)) state.lines = kept.slice(0, 12);
  } catch { /* a phone that won't keep it just starts with an empty order */ }
  const keep = () => {
    try {
      sessionStorage.setItem(KEEP, JSON.stringify(state.lines));
    } catch { /* fine */ }
  };

  const item = (id) => state.menu.items.find((x) => x.id === id);
  const topping = (id) => state.menu.toppings.find((t) => t.id === id);
  const flavour = (id) => state.menu.flavours.find((f) => f.id === id);
  const cap = (text) => text.charAt(0).toUpperCase() + text.slice(1);
  const priceOf = (line) => {
    const o = line.options || {};
    const x = state.menu.extras;
    return item(line.item).price + (o.extraTopping ? x.extraTopping.price : 0) + (o.oat ? x.oat.price : 0) + (o.frozen ? x.frozen.price : 0);
  };
  /** A line in plain words, as the Lair will word it */
  const wordsOf = (line) => {
    const o = line.options || {};
    const w = [];
    if (o.choice) w.push(o.choice);
    if (o.sugarFree) w.push('99% sugar free');
    if (o.flavours?.length) w.push(`${o.flavours.map((f) => flavour(f)?.name).join(' + ')}, ${o.base}`);
    if (o.topping) w.push(topping(o.topping)?.short);
    if (o.extraTopping) w.push(`extra ${topping(o.extraTopping)?.short}`);
    if (o.ice === 'less') w.push('less ice');
    if (o.ice === 'none') w.push('no ice');
    if (o.frozen) w.push('frozen');
    if (o.oat) w.push('oat milk');
    if (o.sweet) w.push('add sweetness');
    if (o.takeaway) w.push('takeaway cup');
    return w.filter(Boolean).join(' · ');
  };
  const resting = (x) => state.menu.rush && !x.rush && x.kind !== 'hot';
  const canOrder = () => Boolean(state.menu.table && state.menu.open);
  const total = () => state.lines.reduce((sum, l) => sum + priceOf(l), 0);
  const plusIcon = () => s('svg', { 'aria-hidden': 'true', width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4, 'stroke-linecap': 'round' }, s('path', { d: 'M12 5v14M5 12h14' }));

  /* ---- the menu ---- */
  function card(x) {
    const count = state.lines.filter((l) => l.item === x.id).length;
    const rest = resting(x);
    const button = rest
      ? h('span', { class: 'small', vars: { color: '#5e5853' } }, 'Resting')
      : count
        ? h('button', { type: 'button', class: 'added', 'aria-label': `${x.name}: ${count} on your order. Add another or change it`, on: { click: () => open({ kind: 'options', draft: draftFor(x) }) } }, `${count} added`)
        : h('button', { type: 'button', class: 'plus', 'aria-label': `Add ${x.name}`, on: { click: () => open({ kind: 'options', draft: draftFor(x) }) } }, plusIcon());
    return h('div', { class: `card${rest ? ' resting' : ''}`, vars: { '--c': look(x.id).c } },
      h('div', { class: 'art' }, mug(x.id, `${x.name} in a ${x.kind === 'hot' ? 'hot' : 'glass'} mug`, 46, ((drawn++) * 3.1) % 8)),
      h('div', { class: 'words' },
        x.fantasy ? h('div', { class: 'fancy' }, x.fantasy) : null,
        x.fantasy
          ? h('div', { class: 'plainname' }, x.no ? h('b', null, `No. ${x.no}`) : null, x.no ? ' · ' : '', x.name)
          : h('div', { class: 'fancy' }, x.name),
        h('div', { class: 'chips' },
          x.describe.split(', ').map((d) => h('span', null, d)),
          x.caffeine ? h('span', { class: 'caf' }, 'caffeine') : null,
          x.tier ? null : h('span', null, money(x.price)))),
      button);
  }
  function tier(name, colour, price, items) {
    if (!items.length) return [];
    return [
      h('div', { class: 'tier', vars: { '--tier': colour } }, h('i', { 'aria-hidden': 'true' }), h('h2', { class: 'fancy' }, name), price ? h('span', { class: 'pill small' }, price) : null),
      items.map(card),
    ];
  }
  const STATUS = { waiting: 'In the queue', making: 'Being made', done: 'On its way', cancelled: 'Cancelled' };
  function myDrinks() {
    const orders = state.mine.filter((o) => o.drinks.length);
    if (!orders.length) return null;
    return h('section', { class: 'notice', 'aria-label': 'Your drinks today' },
      h('h2', { class: 'label', vars: { margin: '0 0 2px' } }, 'Your drinks today'),
      orders.flatMap((o) => o.drinks).map((d) => h('div', { class: 'line' },
        h('div', { class: 'what' }, h('strong', null, d.fantasy || d.name), h('span', { class: 'muted small' }, d.fantasy ? `${d.name}${d.words ? ` · ${d.words}` : ''}` : d.words)),
        h('span', { class: `status ${d.status}` }, STATUS[d.status] || d.status))));
  }
  function menuView() {
    const m = state.menu;
    drawn = 0;
    const of = (t) => m.items.filter((x) => x.tier === t);
    const price = (t) => money(m.tiers[t].price);
    return [
      h('div', { class: 'top' }, brand(), m.table ? h('span', { class: 'pill' }, at(m.table.id)) : null),
      h('p', { class: 'muted' }, 'Order here and it goes on your tab. Pay at the counter when you\'re ready.'),
      state.justOrdered ? h('p', { class: 'notice gold', role: 'status' }, `Ordered. ${money(state.justOrdered)} is on your tab, and we're on it. `, h('a', { href: '/pages/my-lair', vars: { color: '#16110f' } }, 'See your tab')) : null,
      myDrinks(),
      m.table && !m.open ? h('p', { class: 'notice' }, "The Apothecary's closed right now. Order when the Lair's open.") : null,
      m.rush ? h('p', { class: 'notice' }, "It's a rush right now, so only the quick drinks are on. The rest are back soon.") : null,
      tier('Common', '#f8efe2', price('common'), of('common')),
      tier('Rare', '#3cc8d8', price('rare'), of('rare')),
      tier('Legendary', '#f6b93b', price('legendary'), of('legendary')),
      tier('Brew Your Own', '#c9a6ff', null, m.items.filter((x) => x.kind === 'byo')),
      tier('Hot drinks', '#ff8a6b', null, m.items.filter((x) => x.kind === 'hot')),
      h('p', { class: 'muted small' }, 'Every cold drink comes with a topping. Made with creamer, or oat milk if you ask.'),
    ];
  }

  /* ---- make it your way ---- */
  function draftFor(x) {
    const options = {};
    if (x.choices) options.choice = x.choices[0];
    if (x.options.topping) options.topping = x.topping || null;
    if (x.options.ice) options.ice = 'normal';
    if (x.kind === 'byo') Object.assign(options, { base: 'sparkling', flavours: [] });
    return { item: x.id, options };
  }
  /** Why this drink can't go on the order yet, or '' when it can */
  function missing(draft) {
    const x = item(draft.item);
    const o = draft.options;
    if (x.kind === 'byo' && !o.flavours.length) return 'Pick one or two flavours.';
    if (x.kind === 'byo' && !o.topping) return 'Pick a topping.';
    if (o.wantExtra && !o.extraTopping) return 'Pick your extra topping.';
    return '';
  }
  function optionsView(draft) {
    const x = item(draft.item);
    const o = draft.options;
    const again = () => render();
    const pick = (label, on, tap) => h('button', { type: 'button', 'aria-pressed': on ? 'true' : 'false', on: { click: () => { tap(); again(); } } }, label);
    const tick = (id, label, cost, on, tap) => h('div', { class: 'tick' },
      h('input', { id, type: 'checkbox', checked: on, on: { change: (e) => { tap(e.target.checked); again(); } } }),
      h('label', { for: id }, label),
      h('span', { class: cost ? 'cost' : null }, cost ? `+${money(cost)}` : 'free'));
    const creamy = x.kind !== 'byo' || o.base === 'creamer';
    const flavours = x.kind === 'byo' ? state.menu.flavours.filter((f) => o.base === 'creamer' || f.kind === 'fruit') : [];
    const toppings = (chosen, tap, none) => h('div', { class: 'picks' },
      none ? pick('No topping', !chosen, () => tap(null)) : null,
      state.menu.toppings.map((t) => pick(cap(t.short), chosen === t.id, () => tap(t.id))));
    const need = missing(draft);
    const line = { item: draft.item, options: o };
    return [
      h('div', { class: 'crumb' }, h('span', null, `Apothecary${state.menu.table ? ` · ${at(state.menu.table.id)}` : ''}`), h('button', { type: 'button', class: 'ghost', on: { click: close } }, 'Back to the menu')),
      h('div', { class: 'body', vars: { '--c': look(x.id).c } },
        h('div', { class: 'head' },
          h('div', { class: 'art big' }, mug(x.id, `${x.name}`, 60, 0)),
          h('div', null,
            h('h1', { class: 'fancy', id: 'sheet-title', tabindex: '-1' }, x.fantasy || x.name),
            x.fantasy ? h('div', { class: 'plainname' }, x.no ? h('b', null, `No. ${x.no} · `) : null, x.name) : null,
            h('div', { class: 'desc' }, `${x.describe.split(', ').join(' · ')} · `, h('b', null, money(x.price))))),
        x.choices ? [h('h2', { class: 'label' }, `Which ${x.name.toLowerCase()}?`), h('div', { class: 'picks' }, x.choices.map((c) => pick(c, o.choice === c, () => { o.choice = c; if (!x.sugarFree?.includes(c)) delete o.sugarFree; })))] : null,
        x.sugarFree?.includes(o.choice) ? tick('o-sf', '99% sugar free', 0, o.sugarFree, (on) => { o.sugarFree = on; }) : null,
        x.kind === 'byo' ? [
          h('h2', { class: 'label' }, 'Base'),
          h('div', { class: 'picks' },
            pick('Sparkling', o.base === 'sparkling', () => { o.base = 'sparkling'; o.oat = false; o.flavours = o.flavours.filter((f) => flavour(f)?.kind === 'fruit'); }),
            pick('Creamer', o.base === 'creamer', () => { o.base = 'creamer'; })),
          h('h2', { class: 'label' }, 'Flavours: one or two'),
          h('div', { class: 'picks' }, flavours.map((f) => pick(`${cap(f.name)}${f.kind === 'creamy' ? ' (creamy)' : ''}`, o.flavours.includes(f.id), () => {
            if (o.flavours.includes(f.id)) o.flavours = o.flavours.filter((id) => id !== f.id);
            else o.flavours = [...o.flavours, f.id].slice(-2);
          }))),
        ] : null,
        x.options.topping ? [h('h2', { class: 'label' }, 'Topping, included'), toppings(o.topping, (id) => { o.topping = id; }, x.kind === 'shake')] : null,
        x.options.ice && !o.frozen ? [
          h('h2', { class: 'label' }, 'Ice'),
          h('div', { class: 'picks' }, [['normal', 'Normal'], ['less', 'Less ice'], ['none', 'No ice']].map(([id, label]) => pick(label, o.ice === id, () => { o.ice = id; }))),
        ] : null,
        x.options.sweet ? [
          h('h2', { class: 'label' }, 'Your way'),
          h('div', null,
            tick('o-sweet', 'Add sweetness', 0, o.sweet, (on) => { o.sweet = on; }),
            tick('o-take', 'Takeaway cup', 0, o.takeaway, (on) => { o.takeaway = on; }),
            x.options.oat && creamy ? tick('o-oat', x.kind === 'shake' ? 'Oat milk' : 'Oat milk instead of creamer', state.menu.extras.oat.price, o.oat, (on) => { o.oat = on; }) : null,
            tick('o-extra', 'Extra topping', state.menu.extras.extraTopping.price, o.wantExtra, (on) => { o.wantExtra = on; if (!on) delete o.extraTopping; }),
            x.options.frozen ? tick('o-frozen', 'Make it frozen', state.menu.extras.frozen.price, o.frozen, (on) => { o.frozen = on; if (on) o.ice = 'normal'; }) : null),
          o.wantExtra ? [h('h2', { class: 'label' }, 'Your extra topping'), toppings(o.extraTopping, (id) => { o.extraTopping = id; })] : null,
        ] : null,
        h('label', { class: 'label', for: 'o-note' }, 'A note for whoever makes it'),
        h('input', { id: 'o-note', class: 'note', type: 'text', maxlength: 60, value: o.note || '', autocomplete: 'off', on: { input: (e) => { o.note = e.target.value; } } }),
        h('div', { class: 'grow' }),
        need ? h('p', { class: 'muted', role: 'status' }, need) : null,
        h('button', { type: 'button', class: 'go wide', disabled: Boolean(need) || state.lines.length >= 12, on: { click: () => add(draft) } },
          state.lines.length >= 12 ? 'One order holds 12 drinks' : `Add to order · ${money(priceOf(line))}`)),
    ];
  }
  function add(draft) {
    const { wantExtra, note, ...options } = draft.options;
    if (!options.extraTopping) delete options.extraTopping;
    for (const key of ['sweet', 'takeaway', 'oat', 'frozen', 'sugarFree']) if (!options[key]) delete options[key];
    if (String(note || '').trim()) options.note = String(note).trim().slice(0, 60);
    state.lines.push({ item: draft.item, options });
    state.justOrdered = null;
    state.say = '';
    keep();
    close();
  }

  /* ---- your order ---- */
  function reviewView() {
    return [
      h('div', { class: 'crumb' }, h('span', null, `Apothecary${state.menu.table ? ` · ${at(state.menu.table.id)}` : ''}`), h('button', { type: 'button', class: 'ghost', on: { click: close } }, 'Back to the menu')),
      h('div', { class: 'body' },
        h('h1', { class: 'fancy', id: 'sheet-title', tabindex: '-1', vars: { 'font-size': '28px' } }, 'Your order'),
        h('div', null, state.lines.map((l, n) => {
          const x = item(l.item);
          return h('div', { class: 'line' },
            h('div', { class: 'art mini', vars: { '--c': look(x.id).c } }, mug(x.id, x.name, 32)),
            h('div', { class: 'what' }, h('strong', null, x.fantasy || x.name), h('span', { class: 'muted small' }, [x.fantasy ? x.name : '', wordsOf(l), l.options.note ? `“${l.options.note}”` : ''].filter(Boolean).join(' · '))),
            h('span', { class: 'price' }, money(priceOf(l))),
            h('button', { type: 'button', class: 'ghost', 'aria-label': `Take ${x.name} off your order`, on: { click: () => { state.lines.splice(n, 1); keep(); if (state.lines.length) render(); else close(); } } }, 'Remove'));
        })),
        h('div', { class: 'grow' }),
        h('p', { class: 'muted' }, `${state.lines.length} ${state.lines.length === 1 ? 'drink' : 'drinks'} · ${money(total())}. It goes on your tab, and you pay at the counter when you're ready.`),
        h('button', { type: 'button', class: 'go wide', on: { click: close } }, 'Back to the menu')),
    ];
  }

  /* ---- the bar along the bottom ---- */
  function bar() {
    const n = state.lines.length;
    let action = null;
    if (canOrder() && n) {
      action = state.member === false
        ? h('a', { class: 'go order', href: loginUrl(), vars: { display: 'flex', 'align-items': 'center', 'border-radius': '999px', 'font-weight': '600', 'text-decoration': 'none' } }, 'Log in to order')
        : h('button', { type: 'button', class: 'go order', disabled: state.busy, on: { click: order } }, state.busy ? 'Ordering…' : 'Order');
    }
    const sum = n
      ? h('button', { type: 'button', class: 'sum', 'aria-label': `Your order: ${n} ${n === 1 ? 'drink' : 'drinks'}, ${money(total())}. See or change it`, on: { click: () => open({ kind: 'review' }) } },
        h('strong', { id: 'sum' }, `${n} ${n === 1 ? 'drink' : 'drinks'} · ${money(total())}`),
        h('span', { class: 'muted small' }, canOrder() ? (state.member === false ? 'Log in so it goes on your tab' : 'Goes on your tab · tap to change') : 'Scan your table\'s card to order'))
      : h('div', { class: 'sum' }, h('strong', null, canOrder() ? 'Pick a drink' : 'The menu'),
        h('span', { class: 'muted small' }, canOrder() ? 'Tap the green plus on anything you fancy' : !state.menu.table ? 'Scan your table\'s card to order' : 'Closed right now'));
    return h('div', { class: 'bar' },
      state.say ? h('p', { class: 'say', role: 'alert' }, state.say) : null,
      h('div', { class: 'in' }, sum, action));
  }

  async function order() {
    if (state.busy || !state.lines.length) return;
    state.busy = true;
    state.say = '';
    render();
    const sent = state.lines.slice();
    const { status, data } = await lair('POST', 'tavern/orders', { table: code, lines: sent });
    state.busy = false;
    if (status === 200 && data.order) {
      state.lines = state.lines.filter((l) => !sent.includes(l));
      keep();
      state.justOrdered = data.order.total;
      state.member = true;
      state.mine = [data.order, ...state.mine];
      scrollTo({ top: 0, behavior: 'smooth' });
      watch();
    } else if (status === 401) {
      state.member = false;
      state.say = data.error || 'Log in to order, so your drinks go on your tab.';
    } else {
      state.say = data.error || 'That order didn\'t go through. Try again, or order at the counter.';
      if (status === 409 || status === 422) refresh();
    }
    render();
  }

  /* ---- drawing it all, and keeping it fresh ---- */
  let lastFocus = null;
  function open(sheet) {
    lastFocus = document.activeElement;
    state.sheet = sheet;
    render();
    document.getElementById('sheet-title')?.focus();
  }
  function close() {
    state.sheet = null;
    render();
    if (lastFocus?.isConnected) lastFocus.focus();
  }
  function render() {
    if (!state.menu) {
      root.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'top' }, brand()),
        h('p', { class: 'muted', role: 'status' }, state.failed ? 'The menu didn\'t load. Check your signal, or order at the counter.' : 'Brewing the menu…'),
        state.failed ? h('button', { type: 'button', class: 'ghost wide', on: { click: refresh } }, 'Try again') : null));
      return;
    }
    if (state.menu.locked) {
      // only a table's QR card opens the menu
      root.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'top' }, brand()),
        h('p', { class: 'notice gold' }, code ? "That code didn't match a table. Scan the code on your table's card again." : "Scan the code on your table's card to see the menu and order from your seat."),
        h('p', { class: 'muted' }, "The Apothecary pours at the Dice Goblin Lair. Not at a table? Order at the counter.")));
      return;
    }
    const kept = document.activeElement?.id;
    const sheet = state.sheet;
    const y = document.querySelector('.sheet')?.scrollTop || 0;
    // a tapped choice is drawn again, so remember which control had the focus and give it back
    const controls = () => [...root.querySelectorAll('.sheet button, .sheet input')];
    const at = sheet ? controls().indexOf(document.activeElement) : -1;
    root.replaceChildren(
      h('div', { class: 'page', inert: Boolean(sheet), 'aria-hidden': sheet ? 'true' : null }, menuView()),
      sheet
        ? h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sheet-title' }, sheet.kind === 'review' ? reviewView() : optionsView(sheet.draft))
        : bar());
    const drawn = document.querySelector('.sheet');
    if (drawn) {
      drawn.style.animation = sheet.shown ? 'none' : '';
      sheet.shown = true;
      drawn.scrollTop = y;
    }
    if (kept) document.getElementById(kept)?.focus({ preventScroll: true });
    else if (at >= 0) controls()[at]?.focus({ preventScroll: true });
  }
  async function refresh() {
    const menu = await lair('GET', `tavern/menu${code ? `?t=${encodeURIComponent(code)}` : ''}`);
    // without a table's code there's nothing to show, so nothing more is asked
    const mine = menu.data?.locked ? { status: 0 } : await lair('GET', 'tavern/mine');
    if (menu.status === 200) {
      state.menu = menu.data;
      if (!menu.data.locked) state.lines = state.lines.filter((l) => item(l.item));
      state.failed = false;
    } else if (!state.menu) state.failed = true;
    if (mine.status === 200) {
      state.member = true;
      state.mine = mine.data.orders || [];
    } else if (mine.status === 401) state.member = false;
    if (!state.sheet) render();
    watch();
  }
  let timer = null;
  /** While a drink's still being made, ask again every 20 seconds (only while the page is on screen) */
  function watch() {
    clearTimeout(timer);
    const waiting = state.mine.some((o) => o.drinks.some((d) => d.status === 'waiting' || d.status === 'making'));
    if (waiting && !document.hidden) timer = setTimeout(refresh, 20000);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.sheet) close(); });
  render();
  refresh();
}

/** The staff's side: drinks to make, the ring, and each drink's recipe card */
function tavernStaffPage(kit) {
  const { h, s, look, mug, lair, loginUrl, base, at } = kit;
  const root = document.getElementById('app');
  const state = { tables: null, queue: null, gate: '', recipe: null, say: '', ring: false, skew: 0, sure: null, failed: 0 };

  /* ---- the ring: a bell from the phone's speaker and a buzz, every 2 seconds while an order waits ---- */
  let audio = null;
  let ringTimer = null;
  let lock = null;
  function ding() {
    if (!audio) return;
    const t = audio.currentTime + 0.02;
    const out = audio.createGain();
    out.gain.value = 0.9;
    out.connect(audio.destination);
    const voice = (hz, to, at, peak, ends) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(hz, t + at);
      if (to) osc.frequency.exponentialRampToValueAtTime(to, t + at + 0.09);
      gain.gain.setValueAtTime(0.0001, t + at);
      gain.gain.exponentialRampToValueAtTime(peak, t + at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + at + ends);
      osc.connect(gain).connect(out);
      osc.start(t + at);
      osc.stop(t + at + ends + 0.05);
    };
    // two potion bubbles popping...
    voice(260, 520, 0, 0.5, 0.12);
    voice(330, 700, 0.16, 0.5, 0.12);
    // ...then the shop's brass bell, two warm notes falling (G then E), each with a bell's overtones
    for (const [at, hz] of [[0.38, 392], [0.86, 329.6]]) {
      for (const [times, peak, rings] of [[1, 0.5, 1.5], [2, 0.3, 1.1], [3.01, 0.13, 0.7], [4.2, 0.05, 0.4]]) voice(hz * times, 0, at, peak, rings);
    }
    navigator.vibrate?.([200, 120, 200]);
  }
  function ringing() {
    const should = state.ring && (state.queue?.ringing || 0) > 0;
    if (should && !ringTimer) {
      ding();
      ringTimer = setInterval(ding, 3200);
    } else if (!should && ringTimer) {
      clearInterval(ringTimer);
      ringTimer = null;
      navigator.vibrate?.(0);
    }
  }
  async function awake() {
    try {
      if (state.ring && !document.hidden && navigator.wakeLock) lock = await navigator.wakeLock.request('screen');
    } catch { /* the phone may say no (low battery): the ring still works while the screen's on */ }
  }
  async function ringOn() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      await audio.resume();
      state.ring = true;
      ding();
    } catch {
      state.say = "This phone won't let the page make a sound. Check it isn't on silent, then tap again.";
    }
    awake();
    render();
    ringing();
  }
  function ringOff() {
    state.ring = false;
    lock?.release?.().catch(() => {});
    lock = null;
    render();
    ringing();
  }

  const mins = (ms) => Math.max(0, Math.floor(ms / 60000));
  const now = () => Date.now() + state.skew;
  const bell = () => h('span', { class: 'bell' }, s('svg', { 'aria-hidden': 'true', width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    s('path', { d: 'M6 9a6 6 0 0 1 12 0c0 6 2.5 7 2.5 7h-17S6 15 6 9z' }), s('path', { d: 'M10 20a2 2 0 0 0 4 0' })));

  async function act(path, body) {
    state.say = '';
    const { status, data } = await lair('POST', path, body || {});
    if (status !== 200) state.say = data.error || "That didn't go through. Try again.";
    await refresh();
    return status === 200;
  }

  /* ---- the list ---- */
  function drinkRow(order, d, mine) {
    const x = look(d.item);
    return h('div', { class: 'drink' },
      h('div', { class: `art mini${mine ? ' plain' : ''}`, vars: { '--c': x.c } }, mug(d.item, d.name, 32)),
      h('div', { class: 'what' },
        h('strong', null, d.no ? h('span', { class: 'no' }, `${d.no} `) : null, d.recipe?.title || d.name),
        d.words ? h('small', null, d.words) : null,
        d.recipe?.note ? h('span', { class: 'tag' }, `Note: ${d.recipe.note}`) : null),
      mine ? h('button', { type: 'button', class: 'ghost', 'aria-label': `Recipe for ${d.name}`, on: { click: () => openRecipe(order.id, d.id) } }, 'Recipe') : null,
      mine ? h('button', { type: 'button', class: 'go', 'aria-label': `${d.name} for ${at(order.table)} is done`, on: { click: () => act(`tavern/drinks/${encodeURIComponent(d.id)}/done`) } }, 'Done') : null);
  }
  function orderCard(o) {
    const started = Boolean(o.onIt) || !o.ringing;
    const waited = mins(now() - o.at);
    const who = o.onIt ? `${o.onIt.by ? `${o.onIt.by}'s on it` : 'Being made'} · ${mins(now() - o.onIt.at)} min` : started ? `Being made · ${waited} min` : `waiting ${waited} min`;
    return h('section', { class: `order ${started ? 'mine' : 'new'}`, 'aria-label': `${at(o.table)}, ${o.name}` },
      h('div', { class: 'who' }, h('strong', null, `${at(o.table)} · ${o.name}`), h('span', null, who)),
      o.drinks.map((d) => drinkRow(o, d, started)),
      started ? null : h('button', { type: 'button', class: 'go wide', vars: { 'font-size': '17px' }, on: { click: () => act(`tavern/orders/${encodeURIComponent(o.id)}/on-it`) } }, 'On it'));
  }
  function listView() {
    const q = state.queue;
    const n = q.ringing;
    return h('div', { class: 'page' },
      h('div', { class: 'top' }, h('h1', { class: 'fancy' }, 'Drinks to make'),
        h('button', { type: 'button', class: q.rush ? 'pill' : 'ghost', 'aria-pressed': q.rush ? 'true' : 'false', vars: { height: '44px', padding: '0 14px', 'font-size': '13px' }, on: { click: () => act('tavern/rush', { on: !q.rush }) } }, `Rush sign: ${q.rush ? 'out' : 'in'}`)),
      !state.ring
        ? h('button', { type: 'button', class: 'ringer on', on: { click: ringOn } }, bell(), h('span', null, n ? `${n} new ${n === 1 ? 'order' : 'orders'}. Tap here to turn the ring on.` : 'Tap here to turn the ring on, so this phone rings for new orders.'))
        : n
          ? h('div', { class: 'ringer on', role: 'status' }, bell(), h('span', null, `${n} new ${n === 1 ? 'order' : 'orders'}. Rings until someone taps On it.`))
          : h('button', { type: 'button', class: 'ringer ghost', 'aria-pressed': 'true', on: { click: ringOff } }, bell(), h('span', null, 'The ring is on. Keep this page open and it rings for new orders. Tap to turn it off.')),
      state.say ? h('p', { class: 'notice gold', role: 'alert' }, state.say) : null,
      state.failed > 2 ? h('p', { class: 'notice', role: 'alert' }, "This phone has lost the Lair, so the list may be out of date. Check its signal.") : null,
      q.orders.length ? q.orders.map(orderCard) : h('p', { class: 'notice' }, 'No drinks to make. New orders land here, oldest first.'),
      state.tables
        ? h('section', { class: 'notice', 'aria-label': 'Table links' },
          h('h2', { class: 'label', vars: { margin: '0 0 6px' } }, "Each QR card's own order link"),
          h('div', { class: 'picks' }, state.tables.map((tb) => h('a', { class: 'pill', href: `${base}/apothecary?t=${encodeURIComponent(tb.code)}`, vars: { 'text-decoration': 'none', 'min-height': '44px', display: 'flex', 'align-items': 'center' } }, at(tb.id)))))
        : h('button', { type: 'button', class: 'ghost wide', on: { click: async () => {
          const { status, data } = await lair('GET', 'tavern/tables');
          if (status === 200) state.tables = data.tables;
          else state.say = data.error || "The table links didn't load. Try again.";
          render();
        } } }, 'Table links (to try an order, or for QR cards)'),
      h('p', { class: 'muted small' }, q.rush ? 'The Rush sign is out: only the quick drinks can be ordered. It comes in by itself tomorrow.' : 'Oldest order first. Tap Recipe for the amounts and steps.'));
  }

  /* ---- a recipe card ---- */
  function openRecipe(orderId, drinkId) {
    state.recipe = { orderId, drinkId };
    state.sure = null;
    render();
    scrollTo(0, 0);
    document.getElementById('recipe-title')?.focus();
  }
  function recipeView() {
    const o = state.queue.orders.find((x) => x.id === state.recipe.orderId);
    const d = o?.drinks.find((x) => x.id === state.recipe.drinkId);
    if (!d) {
      state.recipe = null;
      return listView();
    }
    const r = d.recipe;
    const back = () => { state.recipe = null; render(); };
    return h('div', { class: 'page', vars: { '--c': look(d.item).c } },
      h('button', { type: 'button', class: 'ghost', vars: { 'align-self': 'flex-start', height: '44px', padding: '0 14px', 'font-size': '14px' }, on: { click: back } }, 'Back to drinks'),
      h('div', { class: 'head rhead' },
        h('div', { class: 'art big', vars: { width: '76px', height: '88px' } }, mug(d.item, d.name, 54)),
        h('div', null,
          h('h1', { class: 'fancy', id: 'recipe-title', tabindex: '-1' }, r.title),
          d.fantasy ? h('div', { class: 'fname' }, `${d.no ? `No. ${d.no} · ` : ''}${d.fantasy}`) : null,
          h('div', { class: 'muted', vars: { 'margin-top': '4px' } }, `${at(o.table)} · ${o.name} · ${r.cup}`))),
      d.words ? h('p', { class: 'notice' }, d.words) : null,
      r.note ? h('p', { class: 'notice gold' }, `Note from ${o.name}: ${r.note}`) : null,
      h('div', { class: 'goes' }, h('h2', null, 'What goes in'), r.ingredients.map((i) => h('div', null, h('span', null, i.what), h('b', null, i.amount)))),
      h('h2', { class: 'label', vars: { margin: '4px 0 0' } }, 'Steps'),
      h('ol', { class: 'steps' }, r.steps.map((step) => h('li', null, h('span', null, step)))),
      r.draft ? h('p', { class: 'muted small' }, "Draft amounts until Mo's list is in.") : null,
      state.say ? h('p', { class: 'notice gold', role: 'alert' }, state.say) : null,
      h('button', { type: 'button', class: 'go wide', vars: { 'font-size': '17px' }, on: { click: async () => { if (await act(`tavern/drinks/${encodeURIComponent(d.id)}/done`)) back(); } } }, 'Done'),
      h('button', { type: 'button', class: 'ghost wide', on: { click: async () => {
        if (state.sure !== d.id) {
          state.sure = d.id;
          render();
          return;
        }
        if (await act(`tavern/drinks/${encodeURIComponent(d.id)}/cancel`)) back();
      } } }, state.sure === d.id ? 'Tap again: it comes off their tab' : "Can't make it: cancel this drink"));
  }

  function render() {
    document.body.classList.add('staff');
    if (state.gate) {
      root.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'top' }, h('h1', { class: 'fancy' }, 'Drinks to make')),
        h('p', { class: 'notice' }, state.gate),
        state.gate401 ? h('a', { class: 'go wide', href: loginUrl(), vars: { display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'border-radius': '999px', 'font-weight': '600', 'text-decoration': 'none' } }, 'Log in') : null));
      return;
    }
    if (!state.queue) {
      root.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'top' }, h('h1', { class: 'fancy' }, 'Drinks to make')), h('p', { class: 'muted', role: 'status' }, 'Fetching the list…')));
      return;
    }
    const kept = document.activeElement?.id;
    root.replaceChildren(state.recipe ? recipeView() : listView());
    if (kept) document.getElementById(kept)?.focus({ preventScroll: true });
  }
  let timer = null;
  async function refresh() {
    clearTimeout(timer);
    const { status, data } = await lair('GET', 'tavern/queue');
    if (status === 200) {
      state.queue = data;
      state.skew = data.now - Date.now();
      state.gate = '';
      state.failed = 0;
    } else if (status === 401 || status === 403) {
      state.gate = data.error || "The drinks list is for the Lair's team.";
      state.gate401 = status === 401;
      state.queue = null;
    } else {
      state.failed += 1;
      if (!state.queue) state.gate = data.error || "The list didn't load. Check this phone's signal.";
    }
    render();
    ringing();
    // every 5 seconds while it's on screen (or ringing), every 30 otherwise
    if (!state.gate401) timer = setTimeout(refresh, document.hidden && !state.ring ? 30000 : 5000);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      awake();
      refresh();
    }
  });
  render();
  refresh();
}

/* ------------------------------------------------------------------------------------------------------------------ */

const PAGES = {
  order: { title: "Goblin's Apothecary: order at the table", app: tavernOrderPage },
  staff: { title: "Goblin's Apothecary: drinks to make", app: tavernStaffPage },
};

/** Which page an address under the store's link to the Lair is ('/tavern' the order page, '/tavern/drinks' the staff's), or null */
export function tavernPageFor(path) {
  const clean = String(path || '').replace(/\/+$/, '');
  // the Tavern became Goblin's Apothecary on 20 Nov 2026 (Mo): both names open the pages
  return ['/apothecary', '/tavern'].includes(clean) ? 'order' : ['/apothecary/drinks', '/tavern/drinks'].includes(clean) ? 'staff' : null;
}

/** A page's whole HTML. nonce: this answer's own, so only the page's own script and styles run. */
export function tavernPageHtml(kind, nonce) {
  const page = PAGES[kind];
  // "<" never appears as itself inside the script, so nothing in it can end the script early
  const script = `const __name=(f)=>f;(${page.app.toString()})((${tavernKit.toString()})(${JSON.stringify(TAVERN_LOOKS)}));`.replace(/<\/(script)/gi, '<\\/$1');
  return `<!doctype html>
<html lang="en-NZ">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#16110f">
<title>${page.title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&family=Rammetto+One&display=swap">
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<main id="app"><noscript><p>The Apothecary's menu needs JavaScript. Order at the counter and we'll sort you out.</p></noscript></main>
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
}

/** The page as the Lair answers with it: never kept, never framed, and only its own code may run */
export function tavernPageResponse(kind) {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const csp = [
    "default-src 'none'", `script-src 'nonce-${nonce}'`, `style-src 'nonce-${nonce}' https://fonts.googleapis.com`,
    'font-src https://fonts.gstatic.com', "connect-src 'self'", "img-src 'self' data:", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  ].join('; ');
  return new Response(tavernPageHtml(kind, nonce), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': csp,
      'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
