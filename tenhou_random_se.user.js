// ==UserScript==
// @name         天凤 通用多语音随机 SE (支持 tenhou.net/3 & tenhou.net/4 + GUI)
// @namespace    https://github.com/myouo/tenhou_se
// @version      3.2.1
// @description  同时支持 tenhou.net/3 与 tenhou.net/4！无侵入式底层 WebAudio 实时热替换，支持男女声独立配置与原声回退
// @match        https://tenhou.net/3/*
// @match        https://tenhou.net/4/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      se.nivalis.is
// @connect      *.nivalis.is
// @connect      127.0.0.1
// @connect      localhost
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const IS_V4 = location.pathname.startsWith('/4');
    const DEFAULT_SE_JSON_URL = 'https://se.nivalis.is/kazusa.json';
    const STORAGE_KEY_URL = 'tenhou_custom_se_url_v3';
    const STORAGE_KEY_ENABLED = 'tenhou_custom_se_enabled_v3';
    const STORAGE_KEY_PRESETS = 'tenhou_custom_se_presets_v3';
    const STORAGE_KEY_ACTIVE_ID = 'tenhou_custom_se_active_id_v3';
    const STORAGE_KEY_SPLIT = 'tenhou_custom_se_split_v3';
    const STORAGE_KEY_MALE_ID = 'tenhou_custom_se_male_id_v3';
    const STORAGE_KEY_FEMALE_ID = 'tenhou_custom_se_female_id_v3';
    const NATIVE_PRESET_ID = '__native__';
    const VIRTUAL_SLOT_PREFIX = 'https://tenhou-random-se.local/slot/';

    const MALE_SLOTS = ['25', '27', '29', '31', '33', '35'];
    const FEMALE_SLOTS = ['26', '28', '30', '32', '34', '36'];
    const SLOT_PAIR = {
        '25': '26', '26': '25',
        '27': '28', '28': '27',
        '29': '30', '30': '29',
        '31': '32', '32': '31',
        '33': '34', '34': '33',
        '35': '36', '36': '35',
    };

    // tenhou.net/4/latest.js 资源包中的原始语音 ID -> /3/ SE 槽位映射
    // 注：不映射 145（经典立直棒音效，男女立直时也会叠加播放）与 111（开局/役满共用提示音）
    const V4_ID_TO_SLOT = {
        107: '9',   // NUKI (拔北)
        // PON (25=C/M, 26=F)
        136: '25', 137: '25',
        141: '26',
        // KAN (27=C/M, 28=F)
        127: '27', 128: '27',
        132: '28',
        // CHI (29=C/M, 30=F)
        118: '29', 119: '29',
        123: '30',
        // RIICHI (31=M, 32=F)
        146: '31',
        150: '32',
        // RON (33=C/M, 34=F)
        154: '33', 155: '33',
        159: '34',
        // TSUMO (35=C/M, 36=F)
        163: '35', 164: '35',
        168: '36',
    };

    const urlAssetCache = new Map(); // resolvedUrl -> Promise<{ url, arrayBuffer, blobUrl }>
    const lastPickIdx = new Map();

    const arrayBufToSlot = new WeakMap();
    const audioBufToSlot = new WeakMap();
    const audioElemToSlot = new WeakMap();
    const blobUrlToSlot = new Map();

    // /4/ 资源包二进制指纹索引（length:fnv1a32 -> slotId），无需修改 latest.js 源码
    const v4FingerprintToSlot = new Map();
    const pendingV4Xhrs = new Set();

    let sharedAudioCtx = null;
    let lastGainNode = null;
    let loadGeneration = 0;
    let v4TaggedCount = 0;
    let uiStatusUpdater = null;

    // 原子化当前生效的语音包快照，切换时后台加载并解码完成后一次性替换，期间不断流
    let activePack = {
        label: '未加载',
        url: '',
        slotPools: new Map(),     // slotId -> Array<{ url, arrayBuffer, blobUrl }>
        decodedPools: new Map(),  // slotId -> AudioBuffer[]
        decodedCtx: null,
        decodingSlots: new Set(),
    };

    const AudioCtx = win.AudioContext || win.webkitAudioContext;
    const OrigAudioContextProto =
        (win.BaseAudioContext && win.BaseAudioContext.prototype) ||
        (AudioCtx ? AudioCtx.prototype : null);
    const origDecodeAudioData = OrigAudioContextProto ? OrigAudioContextProto.decodeAudioData : null;

    function isArrayBuffer(x) {
        return Boolean(
            x &&
            (x instanceof ArrayBuffer ||
                (win.ArrayBuffer && x instanceof win.ArrayBuffer) ||
                Object.prototype.toString.call(x) === '[object ArrayBuffer]')
        );
    }

    function toPageArrayBuffer(ab) {
        const PageUint8 = win.Uint8Array || Uint8Array;
        const src = new Uint8Array(ab);
        const dst = new PageUint8(src.byteLength);
        dst.set(src);
        return dst.buffer;
    }

    function getSavedUrl() {
        try {
            if (typeof GM_getValue === 'function') {
                return GM_getValue(STORAGE_KEY_URL, DEFAULT_SE_JSON_URL);
            }
            return localStorage.getItem(STORAGE_KEY_URL) || DEFAULT_SE_JSON_URL;
        } catch {
            return DEFAULT_SE_JSON_URL;
        }
    }

    function setSavedUrl(url) {
        try {
            if (typeof GM_setValue === 'function') GM_setValue(STORAGE_KEY_URL, url);
            localStorage.setItem(STORAGE_KEY_URL, url);
        } catch {}
    }

    function isEnabled() {
        try {
            if (typeof GM_getValue === 'function') {
                return GM_getValue(STORAGE_KEY_ENABLED, true);
            }
            const v = localStorage.getItem(STORAGE_KEY_ENABLED);
            return v === null ? true : v === 'true';
        } catch {
            return true;
        }
    }

    function setEnabled(flag) {
        try {
            if (typeof GM_setValue === 'function') GM_setValue(STORAGE_KEY_ENABLED, Boolean(flag));
            localStorage.setItem(STORAGE_KEY_ENABLED, String(Boolean(flag)));
        } catch {}
    }

    function getPresets() {
        const fallback = [{ id: 'kazusa', name: '冬馬かずさ（冬马和纱）', url: DEFAULT_SE_JSON_URL }];
        try {
            let raw = null;
            if (typeof GM_getValue === 'function') {
                raw = GM_getValue(STORAGE_KEY_PRESETS, null);
            }
            if (!raw) raw = localStorage.getItem(STORAGE_KEY_PRESETS);
            const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (Array.isArray(list) && list.length > 0) return list;
        } catch {}
        return fallback;
    }

    function savePresets(list) {
        try {
            const json = JSON.stringify(list);
            if (typeof GM_setValue === 'function') GM_setValue(STORAGE_KEY_PRESETS, json);
            localStorage.setItem(STORAGE_KEY_PRESETS, json);
        } catch {}
    }

    function getActivePresetId() {
        try {
            if (typeof GM_getValue === 'function') {
                return GM_getValue(STORAGE_KEY_ACTIVE_ID, 'kazusa');
            }
            return localStorage.getItem(STORAGE_KEY_ACTIVE_ID) || 'kazusa';
        } catch {
            return 'kazusa';
        }
    }

    function setActivePresetId(id) {
        try {
            if (typeof GM_setValue === 'function') GM_setValue(STORAGE_KEY_ACTIVE_ID, id);
            localStorage.setItem(STORAGE_KEY_ACTIVE_ID, id);
        } catch {}
    }

    function isSplitMode() {
        try {
            if (typeof GM_getValue === 'function') {
                return Boolean(GM_getValue(STORAGE_KEY_SPLIT, false));
            }
            return localStorage.getItem(STORAGE_KEY_SPLIT) === 'true';
        } catch {
            return false;
        }
    }

    function setSplitMode(flag) {
        try {
            if (typeof GM_setValue === 'function') GM_setValue(STORAGE_KEY_SPLIT, Boolean(flag));
            localStorage.setItem(STORAGE_KEY_SPLIT, String(Boolean(flag)));
        } catch {}
    }

    function getMalePresetId() {
        try {
            if (typeof GM_getValue === 'function') {
                return GM_getValue(STORAGE_KEY_MALE_ID, NATIVE_PRESET_ID);
            }
            return localStorage.getItem(STORAGE_KEY_MALE_ID) || NATIVE_PRESET_ID;
        } catch {
            return NATIVE_PRESET_ID;
        }
    }

    function setMalePresetId(id) {
        try {
            if (typeof GM_setValue === 'function') GM_setValue(STORAGE_KEY_MALE_ID, id);
            localStorage.setItem(STORAGE_KEY_MALE_ID, id);
        } catch {}
    }

    function getFemalePresetId() {
        try {
            if (typeof GM_getValue === 'function') {
                return GM_getValue(STORAGE_KEY_FEMALE_ID, getActivePresetId());
            }
            return localStorage.getItem(STORAGE_KEY_FEMALE_ID) || getActivePresetId();
        } catch {
            return getActivePresetId();
        }
    }

    function setFemalePresetId(id) {
        try {
            if (typeof GM_setValue === 'function') GM_setValue(STORAGE_KEY_FEMALE_ID, id);
            localStorage.setItem(STORAGE_KEY_FEMALE_ID, id);
        } catch {}
    }

    function pickRandomIndex(slotId, len) {
        if (len <= 1) return 0;
        let idx = Math.floor(Math.random() * len);
        if (idx === lastPickIdx.get(slotId)) {
            idx = (idx + 1 + Math.floor(Math.random() * (len - 1))) % len;
        }
        lastPickIdx.set(slotId, idx);
        return idx;
    }

    function fingerprintBytes(u8, offset, len) {
        let h = 0x811c9dc5;
        const end = offset + len;
        for (let i = offset; i < end; i++) {
            h ^= u8[i];
            h = Math.imul(h, 0x01000193);
        }
        return `${len}:${h >>> 0}`;
    }

    // 解析 tenhou.net/4 二进制资源包 [uint32 id, int16 w, int16 h, uint32 len, payload...]
    function tryIndexTenhouV4Pack(buf) {
        if (!isArrayBuffer(buf) || buf.byteLength < 16) return 0;
        const view = new DataView(buf);
        const u8 = new Uint8Array(buf);
        let pos = 4;
        const candidates = [];

        while (pos + 12 <= buf.byteLength) {
            const id = view.getUint32(pos, true);
            const w = view.getInt16(pos + 4, true);
            const h = view.getInt16(pos + 6, true);
            const len = view.getUint32(pos + 8, true);
            pos += 12;
            if (len > buf.byteLength - pos) return 0; // 非天凤资源包格式
            if (w === 0 && h === 0 && len > 0 && V4_ID_TO_SLOT[id]) {
                candidates.push({ id, offset: pos, len });
            }
            pos += len;
        }

        if (pos !== buf.byteLength || candidates.length === 0) return 0;

        let indexed = 0;
        for (const item of candidates) {
            const fp = fingerprintBytes(u8, item.offset, item.len);
            v4FingerprintToSlot.set(fp, V4_ID_TO_SLOT[item.id]);
            indexed++;
        }
        console.log(`[TenhouRandomSE] 已从 /4/ 资源包精确索引 ${indexed} 个语音 ID`);
        return indexed;
    }

    function ensureV4XhrsIndexed() {
        for (const xhr of Array.from(pendingV4Xhrs)) {
            if (xhr.readyState === 4) {
                pendingV4Xhrs.delete(xhr);
                if (xhr.status === 200 && isArrayBuffer(xhr.response)) {
                    tryIndexTenhouV4Pack(xhr.response);
                }
            }
        }
    }

    const origFetch = win.fetch.bind(win);

    async function smartRequest(url, responseType) {
        if (url.startsWith('https://')) {
            try {
                const res = await origFetch(url, {
                    mode: 'cors',
                    cache: responseType === 'text' ? 'no-cache' : 'default',
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                if (responseType === 'arraybuffer') {
                    return { response: await res.arrayBuffer() };
                }
                return { responseText: await res.text() };
            } catch {
                // 回退到 GM_xmlhttpRequest（绕过 CORS 限制）
            }
        }
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                responseType,
                onload: (res) => {
                    if (res.status >= 200 && res.status < 300) {
                        resolve(res);
                    } else {
                        reject(new Error(`HTTP ${res.status} for ${url}`));
                    }
                },
                onerror: (err) => reject(err),
            });
        });
    }

    function loadAudioAsset(resolvedUrl) {
        if (urlAssetCache.has(resolvedUrl)) return urlAssetCache.get(resolvedUrl);
        const p = smartRequest(resolvedUrl, 'arraybuffer').then((res) => {
            const arrayBuffer = res.response;
            const blob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
            const blobUrl = URL.createObjectURL(blob);
            return { url: resolvedUrl, arrayBuffer, blobUrl };
        }).catch((err) => {
            urlAssetCache.delete(resolvedUrl);
            throw err;
        });
        urlAssetCache.set(resolvedUrl, p);
        return p;
    }

    function resolveAudioUrl(rawUrl, jsonUrl) {
        try {
            return new URL(rawUrl, jsonUrl).href;
        } catch {
            return rawUrl;
        }
    }

    function decodeRawAudioBuffer(ctx, ab) {
        return new Promise((resolve, reject) => {
            try {
                const pageBuf = toPageArrayBuffer(ab);
                let settled = false;
                const onOk = (decoded) => {
                    if (!settled) {
                        settled = true;
                        resolve(decoded);
                    }
                };
                const onErr = (err) => {
                    if (!settled) {
                        settled = true;
                        reject(err || new Error('decodeAudioData failed'));
                    }
                };
                const ret = origDecodeAudioData.call(ctx, pageBuf, onOk, onErr);
                if (ret && typeof ret.then === 'function') {
                    ret.then(onOk, onErr);
                }
            } catch (e) {
                reject(e);
            }
        });
    }

    async function decodeSlotList(ctx, slotId, pool) {
        if (!ctx || !origDecodeAudioData || !pool || !pool.length) return [];
        const decodedList = [];
        for (const item of pool) {
            try {
                const decoded = await decodeRawAudioBuffer(ctx, item.arrayBuffer);
                audioBufToSlot.set(decoded, slotId);
                decodedList.push(decoded);
            } catch (e) {
                console.warn('[TenhouRandomSE] WebAudio 解码失败:', slotId, item.url, e);
            }
        }
        return decodedList;
    }

    async function ensureSlotDecoded(ctx, pack, slotId) {
        if (!ctx || !pack || pack.decodingSlots.has(slotId)) return;
        const pool = pack.slotPools.get(slotId);
        if (!pool || !pool.length) return;
        if (pack.decodedCtx === ctx && pack.decodedPools.has(slotId)) return;
        pack.decodingSlots.add(slotId);
        try {
            const decodedList = await decodeSlotList(ctx, slotId, pool);
            if (decodedList.length > 0 && pack === activePack) {
                pack.decodedCtx = ctx;
                pack.decodedPools.set(slotId, decodedList);
            }
        } finally {
            pack.decodingSlots.delete(slotId);
        }
    }

    async function ensurePackDecoded(ctx, pack) {
        if (!ctx || !pack || pack.slotPools.size === 0) return;
        if (pack.decodedCtx === ctx && pack.decodedPools.size === pack.slotPools.size) return;
        await Promise.all(Array.from(pack.slotPools.keys()).map((id) => ensureSlotDecoded(ctx, pack, id)));
    }

    async function buildPackFromSeJson(jsonUrl, rawText, myGen) {
        const data = JSON.parse(rawText);
        if (!data || typeof data !== 'object' || !data.se || typeof data.se !== 'object') {
            throw new Error('无效的 se.json 格式');
        }

        const baseForRel = (data.meta && data.meta.base)
            ? resolveAudioUrl(data.meta.base, jsonUrl)
            : jsonUrl;

        const nextSlotPools = new Map();
        const rewrittenSe = {};
        const preloadTasks = [];

        for (const [slotId, entry] of Object.entries(data.se)) {
            if (!entry || typeof entry !== 'object') continue;
            const list = [];
            if (Array.isArray(entry.urls)) {
                for (const u of entry.urls) {
                    if (typeof u === 'string' && u.trim()) list.push(resolveAudioUrl(u.trim(), baseForRel));
                }
            }
            if (list.length === 0 && typeof entry.url === 'string' && entry.url.trim()) {
                list.push(resolveAudioUrl(entry.url.trim(), baseForRel));
            }
            if (list.length === 0) continue;

            rewrittenSe[slotId] = { url: `${VIRTUAL_SLOT_PREFIX}${encodeURIComponent(slotId)}.mp3` };

            preloadTasks.push(
                Promise.all(
                    list.map((u) =>
                        loadAudioAsset(u).catch((err) => {
                            console.warn(`[TenhouRandomSE] 预加载失败 (${slotId}):`, u, err);
                            return null;
                        })
                    )
                ).then((assets) => {
                    const valid = assets.filter(Boolean);
                    if (valid.length > 0) {
                        nextSlotPools.set(slotId, valid);
                        for (const item of valid) {
                            blobUrlToSlot.set(item.blobUrl, slotId);
                        }
                    }
                })
            );
        }

        await Promise.all(preloadTasks);
        if (myGen !== loadGeneration) return null;

        if (nextSlotPools.size === 0) {
            throw new Error('没有任何可用的语音文件');
        }

        // 若 AudioContext 已就绪，则在热替换前完成全部新音频的 WebAudio 解码
        const nextDecodedPools = new Map();
        const ctx = sharedAudioCtx;
        if (ctx) {
            await Promise.all(
                Array.from(nextSlotPools.entries()).map(async ([slotId, pool]) => {
                    const decodedList = await decodeSlotList(ctx, slotId, pool);
                    if (decodedList.length > 0) {
                        nextDecodedPools.set(slotId, decodedList);
                    }
                })
            );
            if (myGen !== loadGeneration) return null;
        }

        const label = (data.meta && (data.meta.name || data.meta.id)) || jsonUrl.split('/').pop();
        return {
            pack: {
                label,
                url: jsonUrl,
                slotPools: nextSlotPools,
                decodedPools: nextDecodedPools,
                decodedCtx: ctx || null,
                decodingSlots: new Set(),
            },
            rewrittenText: JSON.stringify({ ver: data.ver || 1.0, se: rewrittenSe }),
        };
    }

    async function fetchAndBuildPack(jsonUrl, myGen) {
        const res = await smartRequest(jsonUrl, 'text');
        if (myGen !== loadGeneration) return null;
        return buildPackFromSeJson(jsonUrl, res.responseText, myGen);
    }

    function pickFromPack(pack, slotId) {
        if (!pack) return null;
        const raw = pack.slotPools.get(slotId) || (SLOT_PAIR[slotId] ? pack.slotPools.get(SLOT_PAIR[slotId]) : null);
        const dec = pack.decodedPools.get(slotId) || (SLOT_PAIR[slotId] ? pack.decodedPools.get(SLOT_PAIR[slotId]) : null);
        return raw ? { raw, dec } : null;
    }

    function mergeGenderPacks(malePack, femalePack, maleLabel, femaleLabel) {
        const slotPools = new Map();
        const decodedPools = new Map();

        const copySlot = (targetSlot, picked) => {
            if (!picked) return;
            slotPools.set(targetSlot, picked.raw);
            if (picked.dec && picked.dec.length > 0) {
                decodedPools.set(targetSlot, picked.dec);
            }
        };

        for (const s of MALE_SLOTS) copySlot(s, pickFromPack(malePack, s));
        for (const s of FEMALE_SLOTS) copySlot(s, pickFromPack(femalePack, s));

        // 拔北(9)等不区分性别的槽位：优先女声配置，其次男声配置
        const allOther = new Set();
        if (femalePack) {
            for (const s of femalePack.slotPools.keys()) {
                if (!SLOT_PAIR[s]) allOther.add(s);
            }
        }
        if (malePack) {
            for (const s of malePack.slotPools.keys()) {
                if (!SLOT_PAIR[s]) allOther.add(s);
            }
        }
        for (const s of allOther) {
            copySlot(s, pickFromPack(femalePack, s) || pickFromPack(malePack, s));
        }

        const decodedCtx = (femalePack && femalePack.decodedCtx) || (malePack && malePack.decodedCtx) || sharedAudioCtx || null;
        return {
            label: `男:${maleLabel} / 女:${femaleLabel}`,
            url: `${malePack ? malePack.url : 'native'}|${femalePack ? femalePack.url : 'native'}`,
            slotPools,
            decodedPools,
            decodedCtx,
            decodingSlots: new Set(),
        };
    }

    async function loadFromUrl(jsonUrl) {
        const myGen = ++loadGeneration;
        if (!isEnabled()) {
            if (uiStatusUpdater) uiStatusUpdater('已禁用（使用原生 SE）');
            return;
        }
        if (!jsonUrl) {
            if (uiStatusUpdater) uiStatusUpdater('未配置 JSON 链接');
            return;
        }
        try {
            const built = await fetchAndBuildPack(jsonUrl, myGen);
            if (!built || myGen !== loadGeneration) return;

            // 原子热替换：立即对下一声游戏音效生效，无需刷新页面
            activePack = built.pack;
            console.log(`[TenhouRandomSE] 已热替换角色「${activePack.label}」，共 ${activePack.slotPools.size} 个槽位（已解码 ${activePack.decodedPools.size} 个）`);
            if (uiStatusUpdater) uiStatusUpdater();
        } catch (err) {
            if (myGen !== loadGeneration) return;
            console.error('[TenhouRandomSE] 加载 se.json 失败（保留当前可用语音）:', jsonUrl, err);
            if (uiStatusUpdater) uiStatusUpdater(`加载失败（保留当前）：${err.message || '请检查链接'}`);
        }
    }

    async function applyCurrentConfig() {
        if (!isSplitMode()) {
            return loadFromUrl(getSavedUrl());
        }
        const myGen = ++loadGeneration;
        if (!isEnabled()) {
            if (uiStatusUpdater) uiStatusUpdater('已禁用（使用原生 SE）');
            return;
        }
        const presets = getPresets();
        const maleId = getMalePresetId();
        const femaleId = getFemalePresetId();
        const malePreset = maleId === NATIVE_PRESET_ID ? null : presets.find((p) => p.id === maleId) || null;
        const femalePreset = femaleId === NATIVE_PRESET_ID ? null : presets.find((p) => p.id === femaleId) || null;

        try {
            let maleBuilt = null;
            let femaleBuilt = null;
            if (malePreset && femalePreset && malePreset.url === femalePreset.url) {
                maleBuilt = await fetchAndBuildPack(malePreset.url, myGen);
                femaleBuilt = maleBuilt;
            } else {
                [maleBuilt, femaleBuilt] = await Promise.all([
                    malePreset ? fetchAndBuildPack(malePreset.url, myGen) : Promise.resolve(null),
                    femalePreset ? fetchAndBuildPack(femalePreset.url, myGen) : Promise.resolve(null),
                ]);
            }
            if (myGen !== loadGeneration) return;

            const malePack = maleBuilt ? maleBuilt.pack : null;
            const femalePack = femaleBuilt ? femaleBuilt.pack : null;
            const maleLabel = malePreset ? malePreset.name : '原生';
            const femaleLabel = femalePreset ? femalePreset.name : '原生';

            activePack = mergeGenderPacks(malePack, femalePack, maleLabel, femaleLabel);
            console.log(`[TenhouRandomSE] 已热替换（男女分开）：${activePack.label}，共 ${activePack.slotPools.size} 个槽位（已解码 ${activePack.decodedPools.size} 个）`);
            if (uiStatusUpdater) uiStatusUpdater();
        } catch (err) {
            if (myGen !== loadGeneration) return;
            console.error('[TenhouRandomSE] 男女分开配置加载失败（保留当前可用语音）:', err);
            if (uiStatusUpdater) uiStatusUpdater(`加载失败（保留当前）：${err.message || '请检查链接'}`);
        }
    }

    // 页面启动即开始后台预加载当前配置
    const initialPreloadPromise = applyCurrentConfig();

    // ==========================================
    // Hook fetch & XMLHttpRequest.prototype (保留原生原型与实例语义)
    // ==========================================
    function isCandidateSeJsonUrl(url) {
        if (typeof url !== 'string') return false;
        if (url.startsWith(VIRTUAL_SLOT_PREFIX)) return false;
        return /\.json(\?.*)?$/i.test(url) && !url.startsWith('https://tenhou.net/');
    }

    function parseSlotFromVirtualUrl(url) {
        if (typeof url !== 'string' || !url.startsWith(VIRTUAL_SLOT_PREFIX)) return null;
        return decodeURIComponent(url.slice(VIRTUAL_SLOT_PREFIX.length).replace(/\.mp3$/i, ''));
    }

    win.fetch = async function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const slotId = parseSlotFromVirtualUrl(url);
        if (slotId) {
            await initialPreloadPromise;
            const pool = activePack.slotPools.get(slotId);
            if (pool && pool.length) {
                const cloneBuf = pool[0].arrayBuffer.slice(0);
                arrayBufToSlot.set(cloneBuf, slotId);
                const resp = new Response(cloneBuf, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
                const origAB = resp.arrayBuffer.bind(resp);
                resp.arrayBuffer = async () => {
                    const ab = await origAB();
                    arrayBufToSlot.set(ab, slotId);
                    return ab;
                };
                return resp;
            }
        }
        if (!IS_V4 && isEnabled() && isCandidateSeJsonUrl(url)) {
            try {
                const res = await smartRequest(url, 'text');
                const myGen = ++loadGeneration;
                const built = await buildPackFromSeJson(url, res.responseText, myGen);
                if (built && myGen === loadGeneration) {
                    activePack = built.pack;
                    if (uiStatusUpdater) uiStatusUpdater();
                    return new Response(built.rewrittenText, { status: 200, headers: { 'Content-Type': 'application/json' } });
                }
            } catch (e) {
                console.warn('[TenhouRandomSE] fetch 拦截 se.json 失败，回退原生:', url, e);
            }
        }
        return origFetch(input, init);
    };

    const OrigXHRProto = win.XMLHttpRequest && win.XMLHttpRequest.prototype;
    if (OrigXHRProto) {
        const xhrUrlMap = new WeakMap();
        const xhrBoundMap = new WeakSet();
        const origXhrOpen = OrigXHRProto.open;
        const origXhrSend = OrigXHRProto.send;

        OrigXHRProto.open = function (method, url, ...rest) {
            xhrUrlMap.set(this, String(url || ''));
            if (IS_V4 && !xhrBoundMap.has(this)) {
                xhrBoundMap.add(this);
                pendingV4Xhrs.add(this);
                this.addEventListener('readystatechange', () => {
                    if (this.readyState === 4) {
                        pendingV4Xhrs.delete(this);
                        if (this.status === 200 && isArrayBuffer(this.response)) {
                            tryIndexTenhouV4Pack(this.response);
                        }
                    }
                });
            }
            return origXhrOpen.call(this, method, url, ...rest);
        };

        OrigXHRProto.send = function (body) {
            const reqUrl = xhrUrlMap.get(this) || '';
            const slotId = parseSlotFromVirtualUrl(reqUrl);
            if (slotId) {
                initialPreloadPromise.then(() => {
                    const pool = activePack.slotPools.get(slotId);
                    const buf = pool && pool.length ? pool[0].arrayBuffer.slice(0) : new ArrayBuffer(0);
                    arrayBufToSlot.set(buf, slotId);
                    Object.defineProperties(this, {
                        readyState: { configurable: true, get: () => 4 },
                        status: { configurable: true, get: () => 200 },
                        statusText: { configurable: true, get: () => 'OK' },
                        response: { configurable: true, get: () => buf },
                    });
                    this.dispatchEvent(new Event('readystatechange'));
                    this.dispatchEvent(new Event('load'));
                });
                return;
            }
            if (!IS_V4 && isEnabled() && isCandidateSeJsonUrl(reqUrl)) {
                smartRequest(reqUrl, 'text')
                    .then((res) => buildPackFromSeJson(reqUrl, res.responseText, ++loadGeneration))
                    .then((built) => {
                        if (!built) return origXhrSend.call(this, body);
                        activePack = built.pack;
                        if (uiStatusUpdater) uiStatusUpdater();
                        Object.defineProperties(this, {
                            readyState: { configurable: true, get: () => 4 },
                            status: { configurable: true, get: () => 200 },
                            statusText: { configurable: true, get: () => 'OK' },
                            responseText: { configurable: true, get: () => built.rewrittenText },
                            response: { configurable: true, get: () => built.rewrittenText },
                        });
                        this.dispatchEvent(new Event('readystatechange'));
                        this.dispatchEvent(new Event('load'));
                    })
                    .catch(() => origXhrSend.call(this, body));
                return;
            }
            return origXhrSend.call(this, body);
        };
    }

    // ==========================================
    // Hook Web Audio API (兼容 /3/ 与 /4/ 原生播放管线，实时热替换)
    // ==========================================
    if (OrigAudioContextProto) {
        const origCreateGain = OrigAudioContextProto.createGain || OrigAudioContextProto.createGainNode;
        if (origCreateGain) {
            const hookGain = function (...args) {
                sharedAudioCtx = this;
                const gn = origCreateGain.apply(this, args);
                lastGainNode = gn;
                return gn;
            };
            if (OrigAudioContextProto.createGain) OrigAudioContextProto.createGain = hookGain;
            if (OrigAudioContextProto.createGainNode) OrigAudioContextProto.createGainNode = hookGain;
        }

        if (origDecodeAudioData) {
            OrigAudioContextProto.decodeAudioData = function (audioData, successCb, errorCb) {
                sharedAudioCtx = this;
                if (activePack.slotPools.size > 0 && activePack.decodedCtx !== this) {
                    ensurePackDecoded(this, activePack);
                }

                let slotId = arrayBufToSlot.get(audioData);
                if (!slotId && IS_V4 && isArrayBuffer(audioData)) {
                    if (v4FingerprintToSlot.size === 0) ensureV4XhrsIndexed();
                    const fp = fingerprintBytes(new Uint8Array(audioData), 0, audioData.byteLength);
                    slotId = v4FingerprintToSlot.get(fp);
                }

                if (typeof successCb === 'function') {
                    return origDecodeAudioData.call(
                        this,
                        audioData,
                        (decoded) => {
                            if (slotId && decoded) {
                                audioBufToSlot.set(decoded, slotId);
                                v4TaggedCount++;
                            }
                            successCb(decoded);
                        },
                        errorCb
                    );
                }
                const p = origDecodeAudioData.call(this, audioData);
                if (p && typeof p.then === 'function') {
                    return p.then((decoded) => {
                        if (slotId && decoded) {
                            audioBufToSlot.set(decoded, slotId);
                            v4TaggedCount++;
                        }
                        return decoded;
                    });
                }
                return p;
            };
        }
    }

    if (win.AudioBufferSourceNode) {
        const srcProto = win.AudioBufferSourceNode.prototype;
        const bufDesc = Object.getOwnPropertyDescriptor(srcProto, 'buffer');
        if (bufDesc && bufDesc.set) {
            Object.defineProperty(srcProto, 'buffer', {
                configurable: true,
                enumerable: bufDesc.enumerable,
                get: bufDesc.get,
                set(val) {
                    try {
                        if (isEnabled() && val) {
                            const slotId = audioBufToSlot.get(val);
                            if (slotId) {
                                const ctx = this.context || sharedAudioCtx;
                                if (ctx && ctx.state === 'suspended') {
                                    ctx.resume().catch(() => {});
                                }
                                const pack = activePack;
                                const pool = pack.decodedPools.get(slotId);
                                if (pool && pool.length > 0) {
                                    const idx = pickRandomIndex(slotId, pool.length);
                                    val = pool[idx];
                                    console.log(`[TenhouRandomSE] WebAudio 热替换 slot[${slotId}] -> #${idx + 1} (${pack.label})`);
                                } else if (pack.slotPools.has(slotId) && ctx) {
                                    // 尚未解码完成时异步补解并回退原生音效，绝不静音
                                    ensureSlotDecoded(ctx, pack, slotId);
                                }
                            }
                        }
                    } catch (e) {
                        console.warn('[TenhouRandomSE] WebAudio 替换异常:', e);
                    }
                    return bufDesc.set.call(this, val);
                },
            });
        }
    }

    const OrigAudio = win.Audio;
    win.Audio = function (src) {
        const slotId = parseSlotFromVirtualUrl(src);
        if (slotId) {
            const audio = new OrigAudio();
            audioElemToSlot.set(audio, slotId);
            const pool = activePack.slotPools.get(slotId);
            if (pool && pool.length) {
                audio.src = pool[pickRandomIndex(slotId, pool.length)].blobUrl;
            }
            return audio;
        }
        return new OrigAudio(src);
    };
    win.Audio.prototype = OrigAudio.prototype;

    const origPlay = win.HTMLMediaElement.prototype.play;
    win.HTMLMediaElement.prototype.play = function (...args) {
        try {
            if (isEnabled()) {
                const curSrc = this.currentSrc || this.src || '';
                const slotId = audioElemToSlot.get(this) || parseSlotFromVirtualUrl(curSrc) || blobUrlToSlot.get(curSrc);
                if (slotId) {
                    audioElemToSlot.set(this, slotId);
                    const pool = activePack.slotPools.get(slotId);
                    if (pool && pool.length > 0) {
                        const idx = pickRandomIndex(slotId, pool.length);
                        const nextUrl = pool[idx].blobUrl;
                        if (this.src !== nextUrl) {
                            this.src = nextUrl;
                            this.load();
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('[TenhouRandomSE] Audio.play 异常:', e);
        }
        return origPlay.apply(this, args);
    };

    // ==========================================
    // 悬浮 GUI 设置窗口（支持 /4/ 与 /3/，实时热切换）
    // ==========================================
    function mountGui() {
        if (document.getElementById('tenhou-se-gui-root')) return;

        const root = document.createElement('div');
        root.id = 'tenhou-se-gui-root';
        root.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;flex-direction:column;align-items:flex-end;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans SC",sans-serif;font-size:13px;line-height:1.4;';

        const toggleBtn = document.createElement('button');
        toggleBtn.textContent = '🎵 自定义 SE';
        toggleBtn.style.cssText = 'display:inline-flex;align-items:center;gap:6px;background:#ffffff;color:#0f172a;border:1px solid #cbd5e1;border-radius:999px;padding:8px 14px;cursor:pointer;box-shadow:0 6px 20px rgba(15,23,42,.16),0 1px 3px rgba(15,23,42,.08);font-weight:600;font-size:13px;letter-spacing:.2px;';

        const panel = document.createElement('div');
        panel.style.cssText = 'display:none;width:348px;max-height:calc(100vh - 80px);overflow-y:auto;background:#ffffff;color:#0f172a;border:1px solid #e2e8f0;border-radius:14px;padding:16px;margin-bottom:10px;box-shadow:0 18px 40px rgba(15,23,42,.22),0 2px 8px rgba(15,23,42,.08);';

        panel.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;padding-bottom:10px;margin-bottom:10px;border-bottom:1px solid #f1f5f9;">
                <div style="display:flex;align-items:center;gap:8px;">
                    <span style="width:8px;height:8px;border-radius:50%;background:#10b981;display:inline-block;"></span>
                    <strong style="font-size:14px;color:#0f172a;font-weight:700;">天凤 SE 替换</strong>
                    <span style="font-size:11px;color:#475569;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:999px;padding:1px 7px;font-weight:600;">${IS_V4 ? '/4/ 4K版' : '/3/ 网页版'}</span>
                </div>
                <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:12px;color:#334155;font-weight:600;">
                    <input id="th-se-enable" type="checkbox" ${isEnabled() ? 'checked' : ''} style="accent-color:#2563eb;cursor:pointer;" /> 启用
                </label>
            </div>

            <div style="display:flex;gap:4px;background:#f1f5f9;padding:3px;border-radius:8px;margin-bottom:10px;">
                <button id="th-se-mode-unified" type="button" style="flex:1;border:none;border-radius:6px;padding:5px 8px;cursor:pointer;font-size:12px;font-weight:600;">统一替换</button>
                <button id="th-se-mode-split" type="button" style="flex:1;border:none;border-radius:6px;padding:5px 8px;cursor:pointer;font-size:12px;font-weight:600;">男女分开</button>
            </div>

            <div id="th-se-unified-box">
                <div style="margin-bottom:5px;font-size:12px;color:#475569;font-weight:600;">已保存配置（选择即实时热切换）</div>
                <div style="display:flex;gap:6px;margin-bottom:10px;">
                    <select id="th-se-preset" style="flex:1;padding:7px 8px;border-radius:8px;border:1px solid #cbd5e1;background:#ffffff;color:#0f172a;font-size:12px;font-weight:500;outline:none;"></select>
                    <button id="th-se-del" title="删除当前配置" style="background:#fff1f2;color:#be123c;border:1px solid #fecdd3;border-radius:8px;padding:7px 10px;cursor:pointer;font-weight:600;font-size:12px;">删除</button>
                </div>
            </div>

            <div id="th-se-split-box" style="display:none;margin-bottom:10px;">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                    <span style="width:40px;font-size:12px;color:#2563eb;font-weight:700;">男声</span>
                    <select id="th-se-male" style="flex:1;padding:6px 8px;border-radius:8px;border:1px solid #cbd5e1;background:#ffffff;color:#0f172a;font-size:12px;font-weight:500;outline:none;"></select>
                </div>
                <div style="display:flex;align-items:center;gap:8px;">
                    <span style="width:40px;font-size:12px;color:#db2777;font-weight:700;">女声</span>
                    <select id="th-se-female" style="flex:1;padding:6px 8px;border-radius:8px;border:1px solid #cbd5e1;background:#ffffff;color:#0f172a;font-size:12px;font-weight:500;outline:none;"></select>
                </div>
            </div>

            <div style="margin-bottom:5px;font-size:12px;color:#475569;font-weight:600;">新增 / 更新配置（名称 & JSON 链接）</div>
            <input id="th-se-name" type="text" placeholder="配置名称（如：冬马和纱 / 雪菜）"
                style="width:100%;box-sizing:border-box;padding:7px 10px;border-radius:8px;border:1px solid #cbd5e1;background:#f8fafc;color:#0f172a;margin-bottom:6px;font-size:12px;outline:none;" />
            <input id="th-se-url" type="text" value="${getSavedUrl().replace(/"/g, '&quot;')}"
                placeholder="https://se.nivalis.is/kazusa.json"
                style="width:100%;box-sizing:border-box;padding:7px 10px;border-radius:8px;border:1px solid #cbd5e1;background:#f8fafc;color:#0f172a;margin-bottom:10px;font-size:12px;outline:none;" />

            <div style="display:flex;gap:8px;margin-bottom:12px;">
                <button id="th-se-save" style="flex:1;background:#2563eb;color:#ffffff;border:none;border-radius:8px;padding:8px 12px;cursor:pointer;font-weight:600;font-size:12px;box-shadow:0 2px 6px rgba(37,99,235,.28);">保存并热替换</button>
                <button id="th-se-apply" style="background:#f1f5f9;color:#334155;border:1px solid #cbd5e1;border-radius:8px;padding:8px 12px;cursor:pointer;font-weight:600;font-size:12px;">仅临时加载</button>
            </div>

            <div id="th-se-status" style="font-size:12px;color:#0369a1;background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:7px 10px;margin-bottom:12px;word-break:break-all;font-weight:500;"></div>

            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                <span style="font-size:11px;color:#64748b;font-weight:600;">点击试听（每次随机切换）</span>
                <div id="th-se-test-gender" style="display:none;gap:4px;">
                    <button type="button" data-g="m" style="padding:2px 8px;border-radius:999px;border:1px solid #cbd5e1;font-size:11px;font-weight:600;cursor:pointer;">男声</button>
                    <button type="button" data-g="f" style="padding:2px 8px;border-radius:999px;border:1px solid #cbd5e1;font-size:11px;font-weight:600;cursor:pointer;">女声</button>
                </div>
            </div>
            <div id="th-se-tests" style="display:flex;flex-wrap:wrap;gap:6px;">
                ${[
                    ['29', '30', '吃'],
                    ['25', '26', '碰'],
                    ['27', '28', '杠'],
                    ['31', '32', '立直'],
                    ['33', '34', '荣'],
                    ['35', '36', '自摸'],
                    ['9', '9', '拔北'],
                ].map(([mId, fId, label]) => `<button data-slot-m="${mId}" data-slot-f="${fId}" style="background:#ffffff;color:#1e293b;border:1px solid #cbd5e1;border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px;font-weight:600;box-shadow:0 1px 2px rgba(15,23,42,.05);">${label}</button>`).join('')}
            </div>
        `;

        root.appendChild(panel);
        root.appendChild(toggleBtn);
        document.body.appendChild(root);

        const modeUnifiedBtn = panel.querySelector('#th-se-mode-unified');
        const modeSplitBtn = panel.querySelector('#th-se-mode-split');
        const unifiedBox = panel.querySelector('#th-se-unified-box');
        const splitBox = panel.querySelector('#th-se-split-box');
        const presetSel = panel.querySelector('#th-se-preset');
        const maleSel = panel.querySelector('#th-se-male');
        const femaleSel = panel.querySelector('#th-se-female');
        const nameInput = panel.querySelector('#th-se-name');
        const urlInput = panel.querySelector('#th-se-url');
        const enableChk = panel.querySelector('#th-se-enable');
        const statusEl = panel.querySelector('#th-se-status');
        const testGenderBox = panel.querySelector('#th-se-test-gender');
        let testGender = 'f';

        function renderTestGenderButtons() {
            testGenderBox.style.display = isSplitMode() ? 'flex' : 'none';
            testGenderBox.querySelectorAll('button').forEach((b) => {
                const active = b.getAttribute('data-g') === testGender;
                b.style.background = active ? '#2563eb' : '#ffffff';
                b.style.color = active ? '#ffffff' : '#475569';
                b.style.borderColor = active ? '#2563eb' : '#cbd5e1';
            });
        }

        function renderModeUI() {
            const split = isSplitMode();
            unifiedBox.style.display = split ? 'none' : 'block';
            splitBox.style.display = split ? 'block' : 'none';
            modeUnifiedBtn.style.background = split ? 'transparent' : '#ffffff';
            modeUnifiedBtn.style.color = split ? '#64748b' : '#0f172a';
            modeUnifiedBtn.style.boxShadow = split ? 'none' : '0 1px 3px rgba(15,23,42,.12)';
            modeSplitBtn.style.background = split ? '#ffffff' : 'transparent';
            modeSplitBtn.style.color = split ? '#0f172a' : '#64748b';
            modeSplitBtn.style.boxShadow = split ? '0 1px 3px rgba(15,23,42,.12)' : 'none';
            renderTestGenderButtons();
        }

        function fillGenderSelect(sel, selectedId, presets) {
            sel.innerHTML = '';
            const nativeOpt = document.createElement('option');
            nativeOpt.value = NATIVE_PRESET_ID;
            nativeOpt.textContent = '天凤原生（不替换）';
            if (selectedId === NATIVE_PRESET_ID) nativeOpt.selected = true;
            sel.appendChild(nativeOpt);
            for (const item of presets) {
                const opt = document.createElement('option');
                opt.value = item.id;
                opt.textContent = item.name;
                if (item.id === selectedId) opt.selected = true;
                sel.appendChild(opt);
            }
        }

        function renderPresets() {
            const presets = getPresets();
            const activeId = getActivePresetId();
            presetSel.innerHTML = '';
            for (const item of presets) {
                const opt = document.createElement('option');
                opt.value = item.id;
                opt.textContent = item.name;
                if (item.id === activeId) opt.selected = true;
                presetSel.appendChild(opt);
            }
            fillGenderSelect(maleSel, getMalePresetId(), presets);
            fillGenderSelect(femaleSel, getFemalePresetId(), presets);

            const active = presets.find((x) => x.id === presetSel.value) || presets[0];
            if (active) {
                nameInput.value = active.name;
                urlInput.value = active.url;
            }
        }

        renderPresets();
        renderModeUI();

        uiStatusUpdater = (customMsg) => {
            if (customMsg) {
                statusEl.textContent = `状态：${customMsg}`;
            } else if (!isEnabled()) {
                statusEl.textContent = '状态：已禁用（使用原生 SE）';
            } else {
                statusEl.textContent = `状态：${activePack.label}（${activePack.slotPools.size} 槽位 / ${activePack.decodedPools.size} 已解码）`;
            }
        };
        uiStatusUpdater();

        toggleBtn.addEventListener('click', () => {
            panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        });

        modeUnifiedBtn.addEventListener('click', async () => {
            if (!isSplitMode()) return;
            setSplitMode(false);
            renderModeUI();
            uiStatusUpdater('正在切换为统一替换模式...');
            await applyCurrentConfig();
        });

        modeSplitBtn.addEventListener('click', async () => {
            if (isSplitMode()) return;
            setSplitMode(true);
            renderModeUI();
            uiStatusUpdater('正在切换为男女分开模式...');
            await applyCurrentConfig();
        });

        maleSel.addEventListener('change', async () => {
            setMalePresetId(maleSel.value);
            setEnabled(true);
            enableChk.checked = true;
            uiStatusUpdater('正在热替换男声配置...');
            await applyCurrentConfig();
        });

        femaleSel.addEventListener('change', async () => {
            setFemalePresetId(femaleSel.value);
            setEnabled(true);
            enableChk.checked = true;
            uiStatusUpdater('正在热替换女声配置...');
            await applyCurrentConfig();
        });

        presetSel.addEventListener('change', async () => {
            const presets = getPresets();
            const picked = presets.find((x) => x.id === presetSel.value);
            if (!picked) return;
            setActivePresetId(picked.id);
            setSavedUrl(picked.url);
            nameInput.value = picked.name;
            urlInput.value = picked.url;
            setEnabled(true);
            enableChk.checked = true;
            uiStatusUpdater(`正在后台加载「${picked.name}」...`);
            await applyCurrentConfig();
        });

        panel.querySelector('#th-se-save').addEventListener('click', async () => {
            const u = urlInput.value.trim();
            if (!u) return;
            const n = nameInput.value.trim() || u.split('/').pop().replace(/\.json$/i, '') || '自定义配置';
            const presets = getPresets();
            const existing = presets.find((x) => x.name === n || x.url === u);
            let targetId;
            if (existing) {
                existing.name = n;
                existing.url = u;
                targetId = existing.id;
            } else {
                targetId = 'p_' + Date.now();
                presets.push({ id: targetId, name: n, url: u });
            }
            savePresets(presets);
            setActivePresetId(targetId);
            setSavedUrl(u);
            renderPresets();
            setEnabled(true);
            enableChk.checked = true;
            uiStatusUpdater(isSplitMode() ? `已保存「${n}」，可在上方男/女下拉中选用` : `已保存，正在热替换「${n}」...`);
            await applyCurrentConfig();
        });

        panel.querySelector('#th-se-del').addEventListener('click', async () => {
            let presets = getPresets();
            const delId = presetSel.value;
            presets = presets.filter((x) => x.id !== delId);
            if (presets.length === 0) {
                presets = [{ id: 'kazusa', name: '冬馬かずさ（冬马和纱）', url: DEFAULT_SE_JSON_URL }];
            }
            savePresets(presets);
            setActivePresetId(presets[0].id);
            setSavedUrl(presets[0].url);
            if (getMalePresetId() === delId) setMalePresetId(NATIVE_PRESET_ID);
            if (getFemalePresetId() === delId) setFemalePresetId(presets[0].id);
            renderPresets();
            uiStatusUpdater(`已切换至「${presets[0].name}」...`);
            await applyCurrentConfig();
        });

        enableChk.addEventListener('change', async () => {
            setEnabled(enableChk.checked);
            if (!enableChk.checked) {
                uiStatusUpdater('已禁用（使用原生 SE）');
            } else {
                uiStatusUpdater('正在加载...');
                await applyCurrentConfig();
            }
        });

        panel.querySelector('#th-se-apply').addEventListener('click', async () => {
            const u = urlInput.value.trim();
            if (!u) return;
            setSavedUrl(u);
            setEnabled(true);
            enableChk.checked = true;
            uiStatusUpdater('正在加载并预解码...');
            await loadFromUrl(u);
        });

        testGenderBox.querySelectorAll('button').forEach((b) => {
            b.addEventListener('click', () => {
                testGender = b.getAttribute('data-g');
                renderTestGenderButtons();
            });
        });

        panel.querySelectorAll('#th-se-tests button').forEach((btn) => {
            btn.addEventListener('click', () => {
                const slot = isSplitMode() && testGender === 'f'
                    ? btn.getAttribute('data-slot-f')
                    : btn.getAttribute('data-slot-m');
                win.__tenhouRandomSE.test(slot);
            });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mountGui);
    } else {
        mountGui();
    }

    win.__tenhouRandomSE = {
        status() {
            const out = {};
            for (const [slotId, pool] of activePack.slotPools.entries()) {
                out[slotId] = {
                    variants: pool.length,
                    decoded: (activePack.decodedPools.get(slotId) || []).length,
                    files: pool.map((x) => x.url.split('/').pop()),
                };
            }
            console.log(
                `[TenhouRandomSE] 当前: ${activePack.label} | 启用: ${isEnabled()} | 模式: ${isSplitMode() ? '男女分开' : '统一'} | AudioCtx: ${sharedAudioCtx ? sharedAudioCtx.state : 'null'} | /4/ 索引: ${v4FingerprintToSlot.size} | 已打标缓冲: ${v4TaggedCount}`
            );
            console.table(out);
            return out;
        },
        async test(slotId = '27') {
            const key = String(slotId);
            const dPool = activePack.decodedPools.get(key);
            if (sharedAudioCtx && dPool && dPool.length > 0) {
                if (sharedAudioCtx.state === 'suspended') {
                    await sharedAudioCtx.resume().catch(() => {});
                }
                const idx = pickRandomIndex(key, dPool.length);
                const bs = sharedAudioCtx.createBufferSource();
                bs.buffer = dPool[idx];
                const dest = (lastGainNode && lastGainNode.gain && lastGainNode.gain.value > 0.05)
                    ? lastGainNode
                    : sharedAudioCtx.destination;
                bs.connect(dest);
                bs.start(0);
                console.log(`[TenhouRandomSE] 试听(WebAudio) slot[${key}] -> #${idx + 1} (${activePack.label})`);
                return;
            }
            const pool = activePack.slotPools.get(key);
            if (!pool || !pool.length) {
                console.warn('[TenhouRandomSE] 该槽位当前为天凤原生或未配置:', key);
                if (uiStatusUpdater) uiStatusUpdater(`槽位 ${key} 当前为原生（未配置替换语音）`);
                return;
            }
            const idx = pickRandomIndex(key, pool.length);
            const a = new OrigAudio(pool[idx].blobUrl);
            await a.play();
            console.log(`[TenhouRandomSE] 试听(Audio) slot[${key}] -> #${idx + 1} (${pool[idx].url})`);
        },
    };
})();
