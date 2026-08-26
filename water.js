/* 滝の流れ — 最新技術5つ
 *  1. WebGL2 / GLSL ES 3.00 … GPU で落下ノイズと白波
 *  2. OffscreenCanvas         … 流れ用ノイズタイルを裏で焼く
 *  3. createImageBitmap       … 焼いたタイルを GPU へ渡す
 *  4. AudioWorklet            … 滝の環境音（開始タップ後）
 *  5. Float32Array            … 飛沫パーティクルを型付き配列で積分
 */
(function (global) {
    const IS_IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const MAX_BACKING = IS_IOS ? 900000 : 1200000;
    const SPRAY = IS_IOS ? 36 : 56;

    const waterEl = document.getElementById('water-gl');
    const api = {
        active: false,
        ready: Promise.resolve(false)
    };

    let gl = null;
    let program = null;
    let noiseTex = null;
    let u = {};
    let spray = new Float32Array(SPRAY * 4);
    let pal = {
        c0: [0.00, 0.10, 0.18],
        c1: [0.00, 0.24, 0.36],
        c2: [0.00, 0.37, 0.45],
        speed: 2.4
    };
    let audioNode = null;
    let audioGain = null;
    let audioStarted = false;
    let audioMuted = false;
    let lastT = 0;

    function capSize(cssW, cssH, dpr) {
        let w = Math.max(1, Math.floor(cssW * dpr));
        let h = Math.max(1, Math.floor(cssH * dpr));
        const px = w * h;
        if (px > MAX_BACKING) {
            const s = Math.sqrt(MAX_BACKING / px);
            w = Math.max(1, Math.floor(w * s));
            h = Math.max(1, Math.floor(h * s));
        }
        return { w, h };
    }

    function bakeNoiseCanvas() {
        const size = 128;
        const off = (typeof OffscreenCanvas === 'function')
            ? new OffscreenCanvas(size, size)
            : Object.assign(document.createElement('canvas'), { width: size, height: size });
        const c2 = off.getContext('2d', { alpha: false });
        const img = c2.createImageData(size, size);
        const d = img.data;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const n1 = hash2(x, y);
                const n2 = hash2(x * 2 + 17, y * 2 + 9);
                const n3 = hash2((x + y) & 127, (x * 3 + y * 5) & 127);
                const v = (n1 * 0.55 + n2 * 0.3 + n3 * 0.15) * 255;
                const i = (y * size + x) * 4;
                d[i] = d[i + 1] = d[i + 2] = v;
                d[i + 3] = 255;
            }
        }
        c2.putImageData(img, 0, 0);
        return off;
    }

    function hash2(x, y) {
        let n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
        return n - Math.floor(n);
    }

    function compile(ctx, type, src) {
        const sh = ctx.createShader(type);
        ctx.shaderSource(sh, src);
        ctx.compileShader(sh);
        if (!ctx.getShaderParameter(sh, ctx.COMPILE_STATUS)) {
            ctx.deleteShader(sh);
            return null;
        }
        return sh;
    }

    const VERT = `#version 300 es
in vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`;

    const FRAG = `#version 300 es
precision mediump float;
uniform float uTime;
uniform vec2 uRes;
uniform vec3 uC0;
uniform vec3 uC1;
uniform vec3 uC2;
uniform float uSpeed;
uniform sampler2D uNoise;
out vec4 fragColor;

float n(vec2 p){
    return texture(uNoise, p).r;
}

void main(){
    vec2 uv = gl_FragCoord.xy / uRes;
    uv.y = 1.0 - uv.y;
    float t = uTime * uSpeed * 0.22;
    float xw = uv.x * 5.5;
    float n1 = n(vec2(xw * 0.35, uv.y * 1.8 - t));
    float n2 = n(vec2(xw * 0.9 + 0.2, uv.y * 3.6 - t * 1.7));
    float n3 = n(vec2(uv.x * 12.0, uv.y * 0.4 - t * 0.15));
    float vein = abs(n3 - 0.5) * 2.0;
    float fall = mix(n1, n2, 0.5);
    vec3 col = mix(uC2, uC1, clamp(uv.y, 0.0, 1.0));
    col = mix(col, uC0, pow(1.0 - uv.y, 1.25));
    float streak = smoothstep(0.15, 0.08, vein) * (0.35 + 0.65 * fall);
    col += vec3(0.45, 0.72, 0.85) * streak * 0.55;
    float steps = fract(uv.y * 7.0 - t * 1.8 + fall * 0.25);
    float foam = smoothstep(0.82, 0.96, steps) * (0.4 + 0.6 * fall);
    col = mix(col, vec3(0.88, 0.97, 1.0), foam * 0.55);
    float mist = smoothstep(0.58, 1.0, uv.y) * 0.18;
    col = mix(col, vec3(0.72, 0.88, 0.96), mist);
    fragColor = vec4(col, 1.0);
}`;

    function initGL(bitmap) {
        if (!waterEl) return false;
        gl = waterEl.getContext('webgl2', {
            alpha: false,
            antialias: false,
            depth: false,
            stencil: false,
            powerPreference: 'low-power'
        });
        if (!gl) return false;
        const vs = compile(gl, gl.VERTEX_SHADER, VERT);
        const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
        if (!vs || !fs) return false;
        program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.bindAttribLocation(program, 0, 'aPos');
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;
        gl.useProgram(program);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1
        ]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        u.time = gl.getUniformLocation(program, 'uTime');
        u.res = gl.getUniformLocation(program, 'uRes');
        u.c0 = gl.getUniformLocation(program, 'uC0');
        u.c1 = gl.getUniformLocation(program, 'uC1');
        u.c2 = gl.getUniformLocation(program, 'uC2');
        u.speed = gl.getUniformLocation(program, 'uSpeed');
        u.noise = gl.getUniformLocation(program, 'uNoise');
        noiseTex = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, noiseTex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
        gl.uniform1i(u.noise, 0);
        return true;
    }

    function seedSpray(w, h) {
        for (let i = 0; i < SPRAY; i++) {
            const o = i * 4;
            spray[o] = Math.random() * w;
            spray[o + 1] = Math.random() * h;
            spray[o + 2] = 2.2 + Math.random() * 4.8;
            spray[o + 3] = 0.25 + Math.random() * 0.75;
        }
    }

    function stepSpray(dt, w, h, playing) {
        const fall = playing ? 1 : 0.55;
        for (let i = 0; i < SPRAY; i++) {
            const o = i * 4;
            spray[o + 1] += spray[o + 2] * fall * dt * 60;
            spray[o + 3] -= 0.004 * fall;
            if (spray[o + 1] > h + 12 || spray[o + 3] <= 0) {
                spray[o] = Math.random() * w;
                spray[o + 1] = -8 - Math.random() * 40;
                spray[o + 2] = 2.2 + Math.random() * 4.8;
                spray[o + 3] = 0.4 + Math.random() * 0.6;
            }
        }
    }

    api.drawSpray = function (ctx, w, h) {
        if (!api.active) return;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < SPRAY; i++) {
            const o = i * 4;
            const a = spray[o + 3];
            ctx.globalAlpha = a * 0.22;
            ctx.fillStyle = '#d7f4ff';
            ctx.beginPath();
            ctx.arc(spray[o], spray[o + 1], 1.2 + a * 1.6, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    };

    api.setPalette = function (c0, c1, c2, speed) {
        pal.c0 = c0;
        pal.c1 = c1;
        pal.c2 = c2;
        pal.speed = speed;
    };

    api.resize = function (cssW, cssH, dpr) {
        if (!waterEl) return;
        const { w, h } = capSize(cssW, cssH, dpr);
        waterEl.width = w;
        waterEl.height = h;
        waterEl.style.width = '100%';
        waterEl.style.height = '100%';
        waterEl.dataset.logicalWidth = String(cssW);
        waterEl.dataset.logicalHeight = String(cssH);
        if (gl) gl.viewport(0, 0, w, h);
        seedSpray(cssW, cssH);
    };

    api.frame = function (nowSec, playing, cssW, cssH) {
        if (!api.active || !gl || !program) return;
        const dt = Math.min(0.05, Math.max(0.008, nowSec - lastT || 0.016));
        lastT = nowSec;
        stepSpray(dt, cssW, cssH, playing);
        gl.useProgram(program);
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.uniform1f(u.time, nowSec);
        gl.uniform2f(u.res, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.uniform3fv(u.c0, pal.c0);
        gl.uniform3fv(u.c1, pal.c1);
        gl.uniform3fv(u.c2, pal.c2);
        gl.uniform1f(u.speed, (playing ? 1 : 0.45) * (1.6 + pal.speed * 0.22));
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    };

    async function startAudioWorklet(ac) {
        const src = `class WaterfallProcessor extends AudioWorkletProcessor {
            constructor(){ super(); this.b = 0; this.b2 = 0; }
            process(_i, outputs){
                const ch = outputs[0][0];
                if (!ch) return true;
                for (let i = 0; i < ch.length; i++){
                    const white = Math.random() * 2 - 1;
                    this.b = this.b * 0.985 + white * 0.015;
                    this.b2 = this.b2 * 0.93 + this.b * 0.07;
                    ch[i] = this.b2 * 0.22;
                }
                return true;
            }
        }
        registerProcessor('waterfall-noise', WaterfallProcessor);`;
        const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
        await ac.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        audioNode = new AudioWorkletNode(ac, 'waterfall-noise');
        audioGain = ac.createGain();
        audioGain.gain.value = audioMuted ? 0 : 0.035;
        audioNode.connect(audioGain).connect(ac.destination);
    }

    api.setMuted = function (on) {
        audioMuted = !!on;
        if (audioGain) audioGain.gain.value = audioMuted ? 0 : 0.035;
    };

    api.startAudio = function () {
        if (audioStarted) return;
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return;
            const ac = (typeof getAudio === 'function') ? getAudio() : new AC();
            if (ac.state === 'suspended') void ac.resume();
            audioStarted = true;
            if (ac.audioWorklet) {
                startAudioWorklet(ac).catch(() => { audioStarted = false; });
            }
        } catch (e) {
            audioStarted = false;
        }
    };

    api.init = function (cssW, cssH, dpr) {
        api.resize(cssW, cssH, dpr);
        api.ready = (async function () {
            try {
                const baked = bakeNoiseCanvas();
                const bitmap = (typeof createImageBitmap === 'function')
                    ? await createImageBitmap(baked)
                    : baked;
                api.active = initGL(bitmap);
                if (bitmap && bitmap.close) bitmap.close();
                if (api.active) api.resize(cssW, cssH, dpr);
                return api.active;
            } catch (e) {
                api.active = false;
                return false;
            }
        })();
        return api.ready;
    };

    global.KoiWater = api;
})(window);
