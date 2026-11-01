// Frozen pre-G09 mixer; source SHA-256 a5ab03ef78c2eb85f46a03bfd8f78e0e68a4b8234547ae465a4d67adf245c7a9
const BUS_IDS = Object.freeze(['music', 'sfx', 'ui']);
/** Source-neutral Web Audio owner. Simulation emits immutable events; this adapter owns every node. */
export class OwnerSafeAudioMixer {
    maxVoicesTotal;
    maxVoicesPerOwner;
    #ownsContext;
    #contextFactory;
    #buffers = new Map();
    #voices = new Map();
    #channels = new Map();
    #busVolumes = new Map(BUS_IDS.map(id => [id, 1]));
    #context;
    #master = null;
    #buses = new Map();
    #masterVolume = 1;
    #decodeJobs = 0;
    #sequence = 0;
    #disposed = false;
    #unlocked = false;
    constructor(options = {}) {
        this.maxVoicesTotal = integerRange(options.maxVoicesTotal ?? 128, 1, 1024, 'maxVoicesTotal');
        this.maxVoicesPerOwner = integerRange(options.maxVoicesPerOwner ?? 32, 1, this.maxVoicesTotal, 'maxVoicesPerOwner');
        this.#context = options.context ?? null;
        this.#ownsContext = options.ownsContext ?? options.context === undefined;
        this.#contextFactory = options.contextFactory ?? defaultContextFactory;
        if (this.#context)
            this.#installGraph(this.#context);
    }
    async unlock() {
        this.#assertLive();
        const context = this.#requireContext();
        if (context.state !== 'running')
            await context.resume();
        this.#unlocked = true;
    }
    async suspend() {
        this.#assertLive();
        const context = this.#context;
        if (!context || context.state === 'suspended')
            return;
        await context.suspend();
    }
    async resume() { await this.unlock(); }
    installBuffer(id, buffer) {
        this.#assertLive();
        const key = identifier(id, 'buffer id');
        if (!buffer || !Number.isFinite(buffer.sampleRate) || buffer.sampleRate <= 0 || !Number.isSafeInteger(buffer.length) || buffer.length < 1 || !Number.isSafeInteger(buffer.numberOfChannels) || buffer.numberOfChannels < 1 || buffer.numberOfChannels > 2)
            throw new TypeError('Audio buffer metadata is invalid.');
        this.#buffers.set(key, buffer);
    }
    async decodeAndInstall(id, bytes) {
        this.#assertLive();
        if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 12)
            throw new TypeError('Encoded audio bytes are invalid.');
        const context = this.#requireContext();
        this.#decodeJobs++;
        try {
            const buffer = await context.decodeAudioData(bytes.slice(0));
            this.#assertLive();
            this.installBuffer(id, buffer);
            return buffer;
        }
        finally {
            this.#decodeJobs--;
        }
    }
    play(request) {
        this.#assertLive();
        if (!this.#unlocked || !this.#context || this.#context.state !== 'running')
            return null;
        const owner = identifier(request.owner, 'owner');
        const channel = identifier(request.channel, 'channel');
        const eventId = identifier(request.eventId, 'event id');
        const buffer = this.#buffers.get(identifier(request.bufferId, 'buffer id'));
        if (!buffer)
            throw new RangeError(`Unknown audio buffer: ${request.bufferId}.`);
        if (!BUS_IDS.includes(request.bus))
            throw new TypeError(`Unknown audio bus: ${String(request.bus)}.`);
        const priority = integerRange(request.priority ?? 0, -1_000_000, 1_000_000, 'priority');
        const ownerChannel = `${owner}\u0000${channel}`;
        const replaced = this.#channels.get(ownerChannel);
        if (request.replaceChannel !== undefined && typeof request.replaceChannel !== 'boolean')
            throw new TypeError('Audio replaceChannel must be boolean.');
        if (replaced && request.replaceChannel === false)
            return null;
        if (replaced)
            this.stopVoice(replaced);
        this.#makeRoom(owner, priority);
        const context = this.#context;
        const source = context.createBufferSource();
        const gain = context.createGain();
        const panner = typeof context.createStereoPanner === 'function' ? context.createStereoPanner() : null;
        source.buffer = buffer;
        source.loop = request.loop ?? false;
        source.playbackRate.setValueAtTime(finiteRange(request.frequency ?? 1, 0.125, 8, 'frequency'), context.currentTime);
        gain.gain.setValueAtTime(finiteRange(request.volume ?? 1, 0, 4, 'volume'), context.currentTime);
        if (panner) {
            panner.pan.setValueAtTime(finiteRange(request.pan ?? 0, -1, 1, 'pan'), context.currentTime);
            source.connect(gain);
            gain.connect(panner);
            panner.connect(this.#buses.get(request.bus));
        }
        else {
            source.connect(gain);
            gain.connect(this.#buses.get(request.bus));
        }
        const sequence = ++this.#sequence;
        const id = `voice:${sequence}`;
        const voice = { id, eventId, owner, channel, priority, sequence, source, gain, panner, retired: false };
        source.onended = () => this.#retire(voice);
        this.#voices.set(id, voice);
        this.#channels.set(ownerChannel, id);
        source.start();
        return id;
    }
    stop(owner, channel) {
        this.#assertLive();
        const ownerId = identifier(owner, 'owner');
        let count = 0;
        for (const voice of [...this.#voices.values()])
            if (voice.owner === ownerId && (channel === undefined || voice.channel === channel)) {
                this.stopVoice(voice.id);
                count++;
            }
        return count;
    }
    setPan(owner, channel, value) {
        this.#assertLive();
        const ownerId = identifier(owner, 'owner');
        const channelId = identifier(channel, 'channel');
        const pan = finiteRange(value, -1, 1, 'pan');
        const voiceId = this.#channels.get(`${ownerId}\u0000${channelId}`);
        const voice = voiceId === undefined ? undefined : this.#voices.get(voiceId);
        if (!voice?.panner || !this.#context)
            return false;
        voice.panner.pan.setValueAtTime(pan, this.#context.currentTime);
        return true;
    }
    stopVoice(id) { const voice = this.#voices.get(id); if (!voice)
        return false; try {
        voice.source.stop();
    }
    catch { /* ended already */ } this.#retire(voice); return true; }
    releaseOwner(owner) { return this.stop(owner); }
    setMasterVolume(value) { this.#masterVolume = finiteRange(value, 0, 4, 'master volume'); if (this.#master && this.#context)
        this.#master.gain.setValueAtTime(this.#masterVolume, this.#context.currentTime); }
    setBusVolume(bus, value) { if (!BUS_IDS.includes(bus))
        throw new TypeError(`Unknown audio bus: ${String(bus)}.`); const volume = finiteRange(value, 0, 4, 'bus volume'); this.#busVolumes.set(bus, volume); const node = this.#buses.get(bus); if (node && this.#context)
        node.gain.setValueAtTime(volume, this.#context.currentTime); }
    removeBuffer(id) { return this.#buffers.delete(id); }
    dispose() {
        if (this.#disposed)
            return;
        this.#disposed = true;
        for (const voice of [...this.#voices.values()])
            this.stopVoice(voice.id);
        for (const node of this.#buses.values())
            try {
                node.disconnect();
            }
            catch { /* idempotent */ }
        try {
            this.#master?.disconnect();
        }
        catch { /* idempotent */ }
        this.#buses.clear();
        this.#buffers.clear();
        this.#channels.clear();
        this.#master = null;
        if (this.#ownsContext)
            void this.#context?.close().catch(() => undefined);
        this.#context = null;
    }
    get stats() {
        const owners = new Set([...this.#voices.values()].map(voice => voice.owner)).size;
        const contextState = this.#context?.state;
        return Object.freeze({ state: this.#disposed || contextState === 'closed' ? 'closed' : !this.#unlocked ? 'locked' : contextState === 'suspended' ? 'suspended' : 'running', buffers: this.#buffers.size, voices: this.#voices.size, owners, audioNodes: (this.#master ? 1 : 0) + this.#buses.size + [...this.#voices.values()].reduce((sum, voice) => sum + 2 + (voice.panner ? 1 : 0), 0), decodeJobs: this.#decodeJobs, sampleRate: this.#context?.sampleRate ?? null, disposed: this.#disposed });
    }
    #requireContext() { this.#assertLive(); if (!this.#context) {
        this.#context = this.#contextFactory();
        this.#installGraph(this.#context);
    } return this.#context; }
    #installGraph(context) { this.#master = context.createGain(); this.#master.gain.setValueAtTime(this.#masterVolume, context.currentTime); this.#master.connect(context.destination); for (const id of BUS_IDS) {
        const node = context.createGain();
        node.gain.setValueAtTime(this.#busVolumes.get(id), context.currentTime);
        node.connect(this.#master);
        this.#buses.set(id, node);
    } }
    #makeRoom(owner, incomingPriority) { while (this.#voices.size >= this.maxVoicesTotal || [...this.#voices.values()].filter(voice => voice.owner === owner).length >= this.maxVoicesPerOwner) {
        const candidates = [...this.#voices.values()].filter(voice => this.#voices.size >= this.maxVoicesTotal || voice.owner === owner).sort((left, right) => left.priority - right.priority || left.sequence - right.sequence || left.id.localeCompare(right.id));
        const victim = candidates[0];
        if (!victim || victim.priority > incomingPriority)
            throw new RangeError('Audio voice budget is exhausted by higher-priority voices.');
        this.stopVoice(victim.id);
    } }
    #retire(voice) { if (voice.retired)
        return; voice.retired = true; voice.source.onended = null; try {
        voice.source.disconnect();
    }
    catch { /* idempotent */ } try {
        voice.gain.disconnect();
    }
    catch { /* idempotent */ } try {
        voice.panner?.disconnect();
    }
    catch { /* idempotent */ } this.#voices.delete(voice.id); const key = `${voice.owner}\u0000${voice.channel}`; if (this.#channels.get(key) === voice.id)
        this.#channels.delete(key); }
    #assertLive() { if (this.#disposed)
        throw new Error('Audio mixer is disposed.'); }
}
function defaultContextFactory() { const Constructor = globalThis.AudioContext ?? globalThis.webkitAudioContext; if (!Constructor)
    throw new Error('Web Audio is unavailable.'); return new Constructor(); }
function identifier(value, label) { if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(value))
    throw new TypeError(`Audio ${label} is invalid.`); return value; }
function integerRange(value, minimum, maximum, label) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new RangeError(`Audio ${label} must be from ${minimum} to ${maximum}.`); return value; }
function finiteRange(value, minimum, maximum, label) { if (!Number.isFinite(value) || value < minimum || value > maximum)
    throw new RangeError(`Audio ${label} must be from ${minimum} to ${maximum}.`); return value; }
