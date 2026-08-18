type CloneResult<T> = { ok: true; value: T } | { ok: false };

export function deepClone<T>(value: T): T {
	const cloned = clonePlainValue(value, new WeakMap<object, unknown>());
	return cloned.ok ? cloned.value : structuredClone(value);
}

function clonePlainValue<T>(value: T, seen: WeakMap<object, unknown>): CloneResult<T> {
	if (value === null || typeof value !== "object") {
		return { ok: true, value };
	}

	const cached = seen.get(value as object);
	if (cached) {
		return { ok: true, value: cached as T };
	}

	if (Array.isArray(value)) {
		const clone: unknown[] = new Array(value.length);
		seen.set(value, clone);
		for (let i = 0; i < value.length; i++) {
			const item = clonePlainValue(value[i], seen);
			if (!item.ok) return item;
			clone[i] = item.value;
		}
		return { ok: true, value: clone as T };
	}

	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		return { ok: false };
	}

	if (Object.getOwnPropertySymbols(value).length > 0) {
		return { ok: false };
	}

	const descriptors = Object.getOwnPropertyDescriptors(value);
	const clone: Record<PropertyKey, unknown> = Object.create(prototype);
	seen.set(value as object, clone);
	for (const key of Object.keys(descriptors)) {
		const descriptor = descriptors[key];
		if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
			return { ok: false };
		}
		const item = clonePlainValue(descriptor.value, seen);
		if (!item.ok) return item;
		clone[key] = item.value;
	}
	return { ok: true, value: clone as T };
}
