import type { Entity } from "./Entity";
import { EcsIds } from "./Global";
import type { World } from "./World";
import { matchesSystemQuery, type SystemQueryDescriptor } from "./Query";

export type TQueryRule = (entity: Entity) => boolean;
export type SystemQuery = TQueryRule | SystemQueryDescriptor;

export class System {
	public readonly id: number = EcsIds.system.next();
	public readonly isSystem = true;
	public name = "";
	public loopTimes = 0;
	public entitySet: WeakMap<World, Set<Entity>> = new WeakMap();
	public usedBy: World[] = [];
	public autoUpdate = true;
	public handler: (entity: Entity, time: number, delta: number, world: World) => unknown;

	protected currentDelta: number = 0;
	protected currentTime: number = 0;
	protected currentWorld: World | null = null;
	protected rule: TQueryRule;
	public readonly queryDescriptor: SystemQueryDescriptor | null;
	private _disabled = false;
	private _priority = 0;

	public get disabled(): boolean {
		return this._disabled;
	}

	public set disabled(value: boolean) {
		this._disabled = value;
	}

	public get priority(): number {
		return this._priority;
	}

	public set priority(v: number) {
		this._priority = v;

		for (const world of this.usedBy) {
			world.updateOrder();
		}
	}

	public constructor(
		rule: SystemQuery,
		handler?: (entity: Entity, time: number, delta: number, world: World) => unknown,
		name?: string,
	) {
		this.name = name ?? this.constructor.name;
		this.disabled = false;
		this.handler = handler ?? (() => {});
		this.queryDescriptor = typeof rule === "function" ? null : rule;
		this.rule = typeof rule === "function" ? rule : entity => matchesSystemQuery(entity, rule);
	}

	public checkEntityManager(world: World): this {
		let weakMapTmp = this.entitySet.get(world);
		if (!weakMapTmp) {
			weakMapTmp = new Set();
			this.entitySet.set(world, weakMapTmp);
		} else {
			weakMapTmp.clear();
		}
		for (const item of this.queryDescriptor ? world.iterQueryCandidates(this.queryDescriptor) : world.entities.values()) {
			if (this.query(item)) {
				weakMapTmp.add(item);
			} else {
				weakMapTmp.delete(item);
			}
		}

		return this;
	}

	public query(entity: Entity): boolean {
		return this.rule(entity);
	}

	public update(world: World, time: number, delta: number): this {
		if (this.disabled) {
			return this;
		}

		const entities = this.entitySet.get(world);
		if (!entities) return this;
		for (const item of entities) {
			this.handle(item, time, delta, world);
		}

		return this;
	}

	public destroy(): this {
		for (let i = this.usedBy.length - 1; i >= 0; i--) {
			const world = this.usedBy[i];
			if (!world) continue;
			world.remove(this);
		}

		return this;
	}

	public handle(entity: Entity, time: number, delta: number, world: World): this {
		this.handler(entity, time, delta, world);

		return this;
	}
}

export type SystemConstructor<TArgs extends unknown[] = never[]> = new (...args: TArgs) => System;
