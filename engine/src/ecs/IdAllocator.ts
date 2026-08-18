export class IdAllocator {
	private _nextId: number;
	private readonly _freeIds: number[] = [];

	constructor(start = 1) {
		this._nextId = Math.max(1, Math.floor(start));
	}

	next(): number {
		return this._freeIds.pop() ?? this._nextId++;
	}

	release(id: number): void {
		if (!Number.isInteger(id) || id <= 0 || id >= this._nextId) return;
		if (this._freeIds.includes(id)) return;
		this._freeIds.push(id);
	}

	reset(start = 1): void {
		this._nextId = Math.max(1, Math.floor(start));
		this._freeIds.length = 0;
	}

	get nextId(): number {
		return this._nextId;
	}
}

export type EcsIdDomain = "entity" | "component" | "system" | "world";

export class EcsIdAllocators {
	readonly entity = new IdAllocator();
	readonly component = new IdAllocator();
	readonly system = new IdAllocator();
	readonly world = new IdAllocator();

	next(domain: EcsIdDomain): number {
		return this[domain].next();
	}

	reset(): void {
		this.entity.reset();
		this.component.reset();
		this.system.reset();
		this.world.reset();
	}
}
