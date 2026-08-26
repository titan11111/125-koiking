/* 竹林・紅葉の SVG をキャンバスへ焼き、層の意匠として描く。feTurbulence は使わない。 */
(function (global) {
    const BAKE = {};
    const READY = {};
    const FILES = {
        sasa: { src: 'images/sasa.svg', w: 240, h: 140 },
        bamboo: { src: 'images/bamboo.svg', w: 80, h: 360 },
        momiji: { src: 'images/momiji.svg', w: 160, h: 176 },
        momijiGold: { src: 'images/momiji-gold.svg', w: 160, h: 176 }
    };

    function bakeOne(key, img, w, h) {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const x = c.getContext('2d');
        x.clearRect(0, 0, w, h);
        x.drawImage(img, 0, 0, w, h);
        BAKE[key] = c;
        READY[key] = true;
    }

    function load(key, spec) {
        READY[key] = false;
        const img = new Image();
        img.onload = function () {
            if (img.naturalWidth > 0) bakeOne(key, img, spec.w, spec.h);
        };
        img.onerror = function () { READY[key] = false; };
        img.src = spec.src;
    }

    function init() {
        Object.keys(FILES).forEach(function (k) { load(k, FILES[k]); });
    }

    function drawSprite(ctx, key, w, h) {
        const c = BAKE[key];
        if (!c || !READY[key]) return false;
        ctx.drawImage(c, -w / 2, -h / 2, w, h);
        return true;
    }

    function drawSasa(ctx, size) {
        const w = size * 5.2;
        return drawSprite(ctx, 'sasa', w, w * (140 / 240));
    }

    function drawMomiji(ctx, size, gold) {
        const s = size * 4.4;
        return drawSprite(ctx, gold ? 'momijiGold' : 'momiji', s, s * (176 / 160));
    }

    function drawBambooScenery(ctx, W, H, distance, alpha) {
        if (!READY.bamboo || alpha <= 0.02) return;
        const c = BAKE.bamboo;
        ctx.save();
        ctx.globalAlpha = alpha;
        const n = 6;
        for (let i = 0; i < n; i++) {
            const left = i < 3;
            const slot = i % 3;
            const w = 28 + slot * 10;
            const h = w * (360 / 80);
            const x = left ? -6 + slot * 16 : W - w + 8 - slot * 14;
            const y = ((distance * 22 + i * 127) % (H + h)) - h * 0.35;
            const sway = Math.sin(distance * 0.08 + i) * 3;
            ctx.drawImage(c, x + sway, y, w, h);
        }
        ctx.restore();
    }

    function drawMomijiScenery(ctx, W, H, distance, alpha) {
        if ((!READY.momiji && !READY.momijiGold) || alpha <= 0.02) return;
        ctx.save();
        ctx.globalAlpha = alpha * 0.85;
        for (let i = 0; i < 5; i++) {
            const gold = i % 2 === 1;
            const key = gold ? 'momijiGold' : 'momiji';
            if (!READY[key]) continue;
            const s = 34 + (i % 3) * 16;
            const x = (i % 2 === 0) ? 18 + (i * 7) : W - 22 - (i * 6);
            const y = ((distance * 16 + i * 90) % (H + 80)) - 40;
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(Math.sin(distance * 0.05 + i) * 0.4);
            ctx.drawImage(BAKE[key], -s / 2, -s / 2, s, s);
            ctx.restore();
        }
        ctx.restore();
    }

    function sceneryAlpha(layerIndex, blendF, wantIndex) {
        if (layerIndex === wantIndex) return 1 - blendF * 0.85;
        if (layerIndex + 1 === wantIndex) return blendF;
        return 0;
    }

    function drawScenery(ctx, W, H, blend, distance) {
        const aB = sceneryAlpha(blend.i, blend.f, 1);
        const aM = sceneryAlpha(blend.i, blend.f, 2);
        drawBambooScenery(ctx, W, H, distance, aB);
        drawMomijiScenery(ctx, W, H, distance, aM);
    }

    global.KoiPlants = {
        init: init,
        ready: READY,
        drawSasa: drawSasa,
        drawMomiji: drawMomiji,
        drawScenery: drawScenery
    };
})(window);
