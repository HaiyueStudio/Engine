// Transport starts only after fixture completion; measurement and timestamps are untouched.
export async function readCompletedFixtureText(cdp, { chunkChars = 1024 * 1024, timeoutMs = 120000, maxChars = 1024 * 1024 * 1024 } = {}) {
    const deadline = Date.now() + timeoutMs;
    async function evaluate(expression) { const remaining = deadline - Date.now(); if (remaining <= 0)
        throw Error('Completed fixture transfer timed out'); const r = await cdp.call('Runtime.evaluate', { expression, returnByValue: true }, Math.min(30000, remaining)); if (r.result?.exceptionDetails)
        throw Error('Completed fixture transfer evaluation failed'); return r.result?.result?.value; }
    try {
        const meta = await evaluate(`(() => { const node=document.querySelector('#result'); if(!node?.dataset.status) throw Error('Fixture not complete'); globalThis.__g09CompletedText=node.textContent; return {status:node.dataset.status,length:globalThis.__g09CompletedText.length}; })()`);
        if (!meta?.status || !Number.isSafeInteger(meta.length) || meta.length <= 0 || meta.length > maxChars)
            throw Error('Invalid completed fixture length');
        const chunks = [];
        for (let start = 0; start < meta.length; start += chunkChars) {
            const end = Math.min(meta.length, start + chunkChars);
            const text = await evaluate(`globalThis.__g09CompletedText.slice(${start},${end})`);
            if (typeof text !== 'string' || text.length !== end - start)
                throw Error('Incomplete completed fixture chunk');
            chunks.push(text);
        }
        const text = chunks.join('');
        if (text.length !== meta.length)
            throw Error('Incomplete completed fixture text');
        return { status: meta.status, text, chunks: chunks.length, characters: meta.length };
    }
    finally {
        await cdp.call('Runtime.evaluate', { expression: 'delete globalThis.__g09CompletedText', returnByValue: true }, 10000).catch(() => { });
    }
}
