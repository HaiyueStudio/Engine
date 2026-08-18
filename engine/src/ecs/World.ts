import { EntitiesCache, SystemOrderCache, getEntitiesCache, getSystemOrderCache } from "./cache";
import { Component, ComponentLifecycleFlags, ComponentUpdateLifecycle, ComponentWorldLifecycle } from "./Component";
import type { ComponentConstructor } from "./Component";
import { Entity, EntityConstructor } from "./Entity";
import { EcsIds } from "./Global";
import { WorldSerialization } from "./interfaces/serialization";
import { System, SystemConstructor } from "./System";
import { add, clear, get, has, remove } from "./utils/ecsManagerOperations";
import { unsortedRemoveValue } from "./utils/unsortedRemove";
import { isIndexableQueryToken, normalizeSystemQuery, type ComponentQueryToken, type SystemQueryDescriptor } from "./Query";
import { FrameData } from "../frame/FrameData";
import type { WorldFrameToken } from "../frame/FrameData";
import { EngineError, EngineErrorCode } from "../core/EngineError";
import { bumpWorldStructureVersion, getWorldStructureVersion } from "./WorldStructure";
import { destroyWorldResources } from "./WorldResourceCleanup";

const sort = (a: System, b: System) => a.priority - b.priority;
type UpdatableComponent = Component & ComponentUpdateLifecycle;
type WorldLifecycleHandlerName = "onEntityAddToWorld" | "onEntityRemoveFromWorld";
type WorldLifecycleComponent = Component & Required<Pick<ComponentWorldLifecycle, WorldLifecycleHandlerName>>;
const COMPONENT_CHANGE_JOURNAL_CAPACITY = 8192;

export type WorldComponentChangeKind = "add" | "remove" | "update";

export interface WorldComponentChange {
	revision: number;
	kind: WorldComponentChangeKind;
	entity: Entity;
	component: Component;
}

/** Reusable cursor over the journals for a fixed set of component types. */
export interface WorldComponentChangeJournal {
	readonly componentTypes: readonly ComponentConstructor[];
	readonly revisions: readonly number[];
}

interface MutableWorldComponentChangeJournal extends WorldComponentChangeJournal {
	readonly revisions: number[];
}

interface ComponentTypeChangeJournal {
	revision: number;
	maxConsumedRevision: number;
	readonly changes: WorldComponentChange[];
	readonly pendingByComponentId: Map<number, WorldComponentChange>;
}

export interface WorldRuntimeIntegration {
	onAttach?(world: World): void;
	onDetach?(world: World): void;
	onSystemRemoved?(system: System, world: World): void;
	shouldUpdateSystem?(system: System, world: World): boolean;
	update?(world: World, time: number, delta: number, frameToken: WorldFrameToken): void;
	clear?(): void;
}

export class World {
	public disabled = false;
	public destroyed = false;
	public name: string;
	public entities = new Map<number, Entity>();
	public systems = new Map<number, System>();
	private _rootEntities = new Set<Entity>();
	private _rootEntitiesCache: Entity[] = [];
	private _rootEntitiesDirty = true;
	private readonly _runtimeIntegrations = new Set<WorldRuntimeIntegration>();
	private readonly _updatableComponents = new Map<UpdatableComponent, Set<Entity>>();
	private readonly _entitiesByComponentConstructor = new Map<Function, Set<Entity>>();
	private readonly _entitiesByComponentSymbol = new Map<symbol, Set<Entity>>();
	private readonly _queryUnionScratch = new Set<Entity>();
	private readonly _emptyQueryCandidates = new Set<Entity>();
	private readonly _frameData = new FrameData();
	private readonly _componentChangeJournal: WorldComponentChange[] = [];
	private readonly _componentTypeChangeJournals = new Map<Function, ComponentTypeChangeJournal>();
	private _componentChangeRevision = 0;

	public readonly id: number = EcsIds.world.next();
	public readonly isWorld = true;

	static unserialize(json: WorldSerialization) {
		const obj = new this(json.name);
		obj.disabled = json.disabled ?? false;

		return obj;
	}

	public constructor(name?: string) {
		this.name = name ?? this.constructor.name;
		EntitiesCache.set(this, new Set());
		SystemOrderCache.set(this, []);
	}

	public get rootEntities(): ReadonlyArray<Entity> {
		return this.rootEntityList;
	}

	public get rootEntityList(): ReadonlyArray<Entity> {
		if (this._rootEntitiesDirty) {
			this._rootEntitiesCache = Array.from(this._rootEntities);
			this._rootEntitiesDirty = false;
		}
		return this._rootEntitiesCache;
	}

	public get frameData(): FrameData {
		return this._frameData;
	}

	/** Monotonic cursor for the non-destructive component change journal. */
	public get componentChangeRevision(): number {
		return this._componentChangeRevision;
	}

	/** Monotonic entity/component hierarchy revision for incremental editor and frame projections. */
	public get structureVersion(): number {
		return getWorldStructureVersion(this);
	}

	/** Copies changes after a cursor. False means the bounded journal overflowed and a full resync is required. */
	public readComponentChangesSince(revision: number, out: WorldComponentChange[]): boolean {
		out.length = 0;
		const current = this._componentChangeRevision;
		if (revision >= current) return true;
		if (revision < current - COMPONENT_CHANGE_JOURNAL_CAPACITY) return false;
		for (let next = revision + 1; next <= current; next++) {
			const change = this._componentChangeJournal[(next - 1) % COMPONENT_CHANGE_JOURNAL_CAPACITY];
			if (!change || change.revision !== next) return false;
			out.push(change);
		}
		return true;
	}

	/**
	 * Creates a non-allocating consumer positioned at the current revision of
	 * the selected component types. The returned cursor can be reused forever.
	 */
	public createComponentChangeJournal(
		componentTypes: readonly ComponentConstructor[],
	): WorldComponentChangeJournal {
		const uniqueTypes: ComponentConstructor[] = [];
		for (const componentType of componentTypes) {
			if (!uniqueTypes.includes(componentType)) uniqueTypes.push(componentType);
		}
		const revisions = new Array<number>(uniqueTypes.length);
		for (let i = 0; i < uniqueTypes.length; i++) {
			const journal = this._getOrCreateComponentTypeJournal(uniqueTypes[i]!);
			revisions[i] = journal.revision;
			journal.maxConsumedRevision = journal.revision;
			journal.pendingByComponentId.clear();
		}
		return {
			componentTypes: Object.freeze(uniqueTypes),
			revisions,
		};
	}

	/** Returns true when one of a cursor's subscribed component types changed. */
	public hasComponentChanges(journal: WorldComponentChangeJournal): boolean {
		for (let i = 0; i < journal.componentTypes.length; i++) {
			const typeJournal = this._componentTypeChangeJournals.get(journal.componentTypes[i]!);
			if (typeJournal && typeJournal.revision !== journal.revisions[i]) return true;
		}
		return false;
	}

	/**
	 * Appends all subscribed changes since the last consume into `out`.
	 * False means one typed journal overflowed; the cursor is advanced and the
	 * caller must perform one full resync.
	 */
	public consumeComponentChanges(
		journal: WorldComponentChangeJournal,
		out: WorldComponentChange[],
	): boolean {
		out.length = 0;
		const mutable = journal as MutableWorldComponentChangeJournal;
		for (let i = 0; i < journal.componentTypes.length; i++) {
			const typeJournal = this._getOrCreateComponentTypeJournal(journal.componentTypes[i]!);
			const revision = journal.revisions[i] ?? 0;
			if (revision < typeJournal.revision - COMPONENT_CHANGE_JOURNAL_CAPACITY) {
				this.resetComponentChangeJournal(journal);
				return false;
			}
		}
		for (let i = 0; i < journal.componentTypes.length; i++) {
			const typeJournal = this._getOrCreateComponentTypeJournal(journal.componentTypes[i]!);
			const revision = journal.revisions[i] ?? 0;
			for (let next = revision + 1; next <= typeJournal.revision; next++) {
				const change = typeJournal.changes[(next - 1) % COMPONENT_CHANGE_JOURNAL_CAPACITY];
				if (!change || change.revision !== next) {
					this.resetComponentChangeJournal(journal);
					out.length = 0;
					return false;
				}
				out.push(change);
			}
			mutable.revisions[i] = typeJournal.revision;
			typeJournal.maxConsumedRevision = typeJournal.revision;
			typeJournal.pendingByComponentId.clear();
		}
		return true;
	}

	/** Advances a typed consumer to now without producing records. */
	public resetComponentChangeJournal(journal: WorldComponentChangeJournal): void {
		const mutable = journal as MutableWorldComponentChangeJournal;
		for (let i = 0; i < journal.componentTypes.length; i++) {
			const typeJournal = this._getOrCreateComponentTypeJournal(journal.componentTypes[i]!);
			mutable.revisions[i] = typeJournal.revision;
			typeJournal.maxConsumedRevision = typeJournal.revision;
			typeJournal.pendingByComponentId.clear();
		}
	}

	/** Records an in-place component mutation relevant to incremental services. */
	public notifyEntityComponentChanged(entity: Entity, component: Component): void {
		if (this.entities.get(entity.id) !== entity || !entity.components.has(component.id)) return;
		this._recordComponentChange("update", entity, component);
	}

	/** Invalidates hierarchy projections after an owned entity is reparented. */
	public notifyEntityHierarchyChanged(entity: Entity): void {
		if (this.entities.get(entity.id) !== entity) return;
		bumpWorldStructureVersion(this);
	}

	public add<T extends EntityConstructor>(element: T, ...args: ConstructorParameters<T>): this;
	public add<T extends SystemConstructor>(element: T, ...args: ConstructorParameters<T>): this;
	public add(element: Entity | System): this;
	public add(element: Entity | System | EntityConstructor | SystemConstructor, ...args: unknown[]): this {
		if (element instanceof Entity) {
			return this.addEntity(element as Entity);
		} else if (element instanceof System) {
			return this.addSystem(element as System);
		}
		const Constructor = element as new (...constructorArgs: unknown[]) => Entity | System;
		return this.add(new Constructor(...args));
	}

	public addEntity<T extends EntityConstructor>(entity: T, ...args: ConstructorParameters<T>): this;
	public addEntity(entity: Entity): this;
	public addEntity<T extends EntityConstructor>(entity: Entity | T, ...args: ConstructorParameters<T>): this {
		this._assertAlive();
		const e = entity instanceof Entity ? entity : new entity(...args);
		if (e.children.length === 0) {
			this._assertEntityAttachable(e);
			const added = add(e, this.entities, this as World);
			if (!added) return this;
			bumpWorldStructureVersion(this);
			this._indexEntityComponents(e);
			this.updateRootEntity(e);
			getEntitiesCache(this).add(e);
			this._notifyEntityAddedToWorld(e);
			return this;
		}
		const hierarchy = this._collectEntityHierarchy(e, null);
		for (const item of hierarchy) {
			this._assertEntityAttachable(item);
			const added = add(item, this.entities, this as World);
			if (!added) continue;
			bumpWorldStructureVersion(this);
			this._indexEntityComponents(item);
			this.updateRootEntity(item);
			getEntitiesCache(this).add(item);
			this._notifyEntityAddedToWorld(item);
		}

		return this;
	}

	/** Explicitly moves an entity subtree from its current World into this World. */
	public transferEntity(entity: Entity): this {
		this._assertAlive();
		const source = entity.world;
		if (source === this) return this;
		const hierarchy = this._collectEntityHierarchy(entity, source);
		for (const item of hierarchy) {
			if (item.world && item.world !== source) {
				throw new EngineError(
					EngineErrorCode.EcsHierarchyInvalid,
					`Entity subtree rooted at "${entity.name}" is split across multiple Worlds.`,
					{ context: { rootEntityId: entity.id, entityId: item.id, worldId: item.world.id } },
				);
			}
		}
		source?.removeEntity(entity);
		return this.addEntity(entity);
	}

	public addSystem<T extends SystemConstructor>(system: T, ...args: ConstructorParameters<T>): this;
	public addSystem(system: System): this;
	public addSystem<T extends SystemConstructor>(system: System | T, ...args: ConstructorParameters<T>): this {
		this._assertAlive();
		const s = system instanceof System ? system : new system(...args);
		add(s, this.systems, this as World);
		s.checkEntityManager(this);

		return this.updateOrder();
	}

	public clear(): this {
		return this.clearSystems().clearEntities();
	}

	public clearEntities(): this {
		for (const entity of [...this.entities.values()]) this._removeEntityRecord(entity);
		destroyWorldResources(this);
		this._updatableComponents.clear();
		this._entitiesByComponentConstructor.clear();
		this._entitiesByComponentSymbol.clear();
		this._queryUnionScratch.clear();
		this._rootEntities.clear();
		this._rootEntitiesCache.length = 0;
		this._rootEntitiesDirty = false;

		return this;
	}

	public clearSystems(): this {
		for (const integration of this._runtimeIntegrations) integration.clear?.();
		clear(this.systems, this as World);

		return this;
	}

	public createEntity(name: string): Entity {
		const entity = new Entity(name);
		this.addEntity(entity);

		return entity;
	}

	public destroy(): this {
		if (this.destroyed) return this;
		this.destroyed = true;
		const arr1 = Array.from(this.systems);
		for (let item of arr1) {
			if (item[1].usedBy.length === 1) {
				item[1].destroy();
			} else {
				this.removeSystem(item[1]);
			}
		}
		for (const entity of [...this.rootEntityList]) entity.destroy();
		// Also clean malformed/orphaned records rather than leaking their components.
		for (const entity of [...this.entities.values()]) entity.destroy();
		destroyWorldResources(this);

		this.disabled = true;
		this.clearRuntimeIntegrations();

		return this;
	}

	public getEntity(entity: number | string | EntityConstructor): Entity | null {
		return get(this.entities, entity);
	}

	public getSystem(system: number | string | SystemConstructor): System | null {
		return get(this.systems, system);
	}

	public hasEntity(entity: Entity | string | number): boolean {
		return has(this.entities, entity);
	}

	public hasSystem(system: System | string | number | SystemConstructor): boolean {
		return has(this.systems, system);
	}

	public remove(element: Entity | System | SystemConstructor): this {
		if (element instanceof System || typeof element === "function") {
			return this.removeSystem(element);
		} else {
			return this.removeEntity(element);
		}
	}

	public destroyEntity(entity: Entity | number | string | EntityConstructor): this {
		const resolvedEntity = this._resolveEntity(entity);
		resolvedEntity?.destroy();
		return this;
	}

	public removeEntity(entity: Entity | number | string | EntityConstructor): this {
		const resolvedEntity = this._resolveEntity(entity);

		if (!resolvedEntity) {
			return this;
		}
		const parent = resolvedEntity.parent;
		if (parent?.world === this) {
			const childIndex = parent.children.indexOf(resolvedEntity);
			if (childIndex >= 0) parent.children.splice(childIndex, 1);
			resolvedEntity.parent = null;
		}
		if (resolvedEntity.children.length === 0) {
			this._removeEntityRecord(resolvedEntity);
			return this;
		}
		const hierarchy = this._collectOwnedHierarchy(resolvedEntity);

		for (const item of hierarchy) this._removeEntityRecord(item);

		return this;
	}

	public removeSystem(system: System | string | number | SystemConstructor): this {
		let systemTmp: System | undefined;

		if (typeof system === "number" || typeof system === "string") {
			systemTmp = get(this.systems, system) ?? undefined;
		} else if (system instanceof System) {
			if (this.systems.has(system.id)) {
				systemTmp = system;
			}
		} else {
			for (let item of this.systems) {
				if (item[1].constructor === system) {
					systemTmp = item[1];
					break;
				}
			}
		}

		if (systemTmp) {
			for (const integration of this._runtimeIntegrations) integration.onSystemRemoved?.(systemTmp, this);
			systemTmp.entitySet.delete(this);
			unsortedRemoveValue(systemTmp.usedBy, this);
			remove(this.systems, systemTmp, this as World);
		}

		return this.updateOrder();
	}

	public addRuntimeIntegration(integration: WorldRuntimeIntegration): this {
		if (this._runtimeIntegrations.has(integration)) return this;
		this._runtimeIntegrations.add(integration);
		integration.onAttach?.(this);
		return this;
	}

	public removeRuntimeIntegration(integration: WorldRuntimeIntegration): this {
		if (!this._runtimeIntegrations.delete(integration)) return this;
		integration.onDetach?.(this);
		return this;
	}

	public clearRuntimeIntegrations(): this {
		for (const integration of this._runtimeIntegrations) integration.onDetach?.(this);
		this._runtimeIntegrations.clear();
		return this;
	}

	public updateRootEntity(entity: Entity): void {
		if (!this.entities.has(entity.id)) return;
		if (entity.parent) {
			this._removeRootEntity(entity);
		} else {
			this._addRootEntity(entity);
		}
	}

	public update(time = performance.now(), delta = 0): this {
		if (this.disabled) {
			return this;
		}
		this._frameData.begin(this, null, time, delta);

		this._updateComponents(time, delta);
		this._refreshSystemQueries();

		const systems = getSystemOrderCache(this);
		systems.forEach((system) => {
			if (system.autoUpdate && this._shouldUpdateSystem(system)) {
				system.update(this, time, delta);
			}
		});
		if (EntitiesCache.get(this)?.size) this._refreshSystemQueries();
		const frameToken = this._frameData.advancePhase();
		for (const integration of this._runtimeIntegrations) integration.update?.(this, time, delta, frameToken);

		return this;
	}

	public updateOrder() {
		const arr: System[] = [];
		this.systems.forEach((element) => {
			arr.push(element);
		});
		arr.sort(sort);
		SystemOrderCache.set(this, arr);

		return this;
	}

	public iterQueryCandidates(query: SystemQueryDescriptor): Iterable<Entity> {
		const normalized = normalizeSystemQuery(query);
		let best: Set<Entity> | null = null;

		for (const token of normalized.all) {
			const set = this._getIndexedEntitiesForQueryToken(token);
			if (!set) {
				if (isIndexableQueryToken(token)) return this._emptyQueryCandidates;
				return this.entities.values();
			}
			if (!best || set.size < best.size) best = set;
		}

		if (best) return best;

		if (normalized.any.length > 0) {
			this._queryUnionScratch.clear();
			for (const token of normalized.any) {
				const set = this._getIndexedEntitiesForQueryToken(token);
				if (!set) {
					if (isIndexableQueryToken(token)) continue;
					this._queryUnionScratch.clear();
					return this.entities.values();
				}
				for (const entity of set) this._queryUnionScratch.add(entity);
			}
			return this._queryUnionScratch;
		}

		return this.entities.values();
	}

	private _updateComponents(time: number, delta: number): void {
		for (const [component, entities] of this._updatableComponents) {
			if (component.disabled) continue;
			for (const entity of entities) {
				if (entity.disabled || !this.entities.has(entity.id) || !entity.components.has(component.id)) continue;
				component.onUpdate(entity, time, delta, this);
			}
		}
	}

	private _assertAlive(): void {
		if (!this.destroyed) return;
		throw new EngineError(
			EngineErrorCode.EcsWorldDestroyed,
			`World "${this.name}" (${this.id}) has been destroyed.`,
			{ context: { worldId: this.id, worldName: this.name } },
		);
	}

	private _resolveEntity(entity: Entity | number | string | EntityConstructor): Entity | null {
		if (entity instanceof Entity) return this.entities.get(entity.id) === entity ? entity : null;
		return get(this.entities, entity);
	}

	private _assertEntityAttachable(entity: Entity): void {
		if (entity.destroyed) {
			throw new EngineError(
				EngineErrorCode.EcsEntityDestroyed,
				`Entity "${entity.name}" (${entity.id}) has been destroyed.`,
				{ context: { entityId: entity.id, entityName: entity.name } },
			);
		}
		if (entity.world && entity.world !== this) throw this._ownershipConflict(entity, entity.world);
	}

	private _collectEntityHierarchy(root: Entity, allowedOwner: World | null): Entity[] {
		const hierarchy: Entity[] = [];
		const visited = new Set<Entity>();
		const pending: Array<{ entity: Entity; expectedParent: Entity | null }> = [{ entity: root, expectedParent: null }];
		while (pending.length > 0) {
			const entry = pending.pop();
			if (!entry) continue;
			const { entity, expectedParent } = entry;
			if (visited.has(entity)) {
				throw new EngineError(
					EngineErrorCode.EcsHierarchyInvalid,
					`Entity hierarchy rooted at "${root.name}" contains a cycle or duplicate child.`,
					{ context: { rootEntityId: root.id, entityId: entity.id } },
				);
			}
			if (entity.destroyed) {
				throw new EngineError(
					EngineErrorCode.EcsEntityDestroyed,
					`Entity "${entity.name}" (${entity.id}) has been destroyed.`,
					{ context: { entityId: entity.id, entityName: entity.name } },
				);
			}
			if (expectedParent && entity.parent !== expectedParent) {
				throw new EngineError(
					EngineErrorCode.EcsHierarchyInvalid,
					`Entity "${entity.name}" has an inconsistent parent/children relationship.`,
					{ context: { entityId: entity.id, expectedParentId: expectedParent.id, parentId: entity.parent?.id ?? null } },
				);
			}
			const owner = entity.world;
			if (owner && owner !== this && owner !== allowedOwner) {
				throw this._ownershipConflict(entity, owner);
			}
			if (entity === root && allowedOwner === null && entity.parent && entity.parent.world !== this) {
				throw this._ownershipConflict(entity, entity.parent.world);
			}
			visited.add(entity);
			hierarchy.push(entity);
			for (let i = entity.children.length - 1; i >= 0; i--) {
				const child = entity.children[i];
				if (child) pending.push({ entity: child, expectedParent: entity });
			}
		}
		return hierarchy;
	}

	private _collectOwnedHierarchy(root: Entity): Entity[] {
		const hierarchy: Entity[] = [];
		const visited = new Set<Entity>();
		const pending: Entity[] = [root];
		while (pending.length > 0) {
			const entity = pending.pop();
			if (!entity || visited.has(entity) || this.entities.get(entity.id) !== entity) continue;
			visited.add(entity);
			hierarchy.push(entity);
			for (let i = entity.children.length - 1; i >= 0; i--) {
				const child = entity.children[i];
				if (child) pending.push(child);
			}
		}
		return hierarchy;
	}

	private _removeEntityRecord(entity: Entity): void {
		if (this.entities.get(entity.id) !== entity) return;
		this._notifyEntityRemovedFromWorld(entity);
		this._unindexEntityComponents(entity);
		this._removeRootEntity(entity);
		getEntitiesCache(this).delete(entity);
		remove(this.entities, entity, this as World);
		bumpWorldStructureVersion(this);
		this.systems.forEach((system: System) => {
			system.entitySet.get(this)?.delete(entity);
		});
	}

	private _ownershipConflict(entity: Entity, owner: World | null): EngineError {
		return new EngineError(
			EngineErrorCode.EcsWorldOwnershipConflict,
			owner
				? `Entity "${entity.name}" (${entity.id}) already belongs to another World.`
				: `Entity "${entity.name}" (${entity.id}) has a parent that is not owned by the target World.`,
			{
				context: { entityId: entity.id, ownerWorldId: owner?.id ?? null, targetWorldId: this.id },
				hint: "Use targetWorld.transferEntity(entity) to move the entity subtree explicitly.",
			},
		);
	}

	private _addRootEntity(entity: Entity): void {
		if (this._rootEntities.has(entity)) return;
		this._rootEntities.add(entity);
		this._rootEntitiesDirty = true;
	}

	private _removeRootEntity(entity: Entity): void {
		if (!this._rootEntities.delete(entity)) return;
		this._rootEntitiesDirty = true;
	}

	private _shouldUpdateSystem(system: System): boolean {
		for (const integration of this._runtimeIntegrations) {
			if (integration.shouldUpdateSystem?.(system, this) === false) return false;
		}
		return true;
	}

	private _refreshSystemQueries(): void {
		const dirtyEntities = EntitiesCache.get(this);
		if (!dirtyEntities?.size) {
			return;
		}

		const systems = getSystemOrderCache(this);
		dirtyEntities.forEach((entity) => {
			const exists = this.entities.has(entity.id);
			systems.forEach((system) => {
				const entitySet = system.entitySet.get(this);
				if (!entitySet) {
					return;
				}
				if (!exists) {
					entitySet.delete(entity);
				} else if (system.query(entity)) {
					entitySet.add(entity);
				} else {
					entitySet.delete(entity);
				}
			});
		});
		dirtyEntities.clear();
	}

	private _notifyEntityAddedToWorld(entity: Entity): void {
		entity.components.forEach((component) => {
			this._recordComponentChange("add", entity, component);
			this._registerUpdatableComponent(entity, component);
			this._callWorldLifecycleHandler(component, "onEntityAddToWorld", entity);
		});
	}

	private _notifyEntityRemovedFromWorld(entity: Entity): void {
		entity.components.forEach((component) => {
			this._recordComponentChange("remove", entity, component);
			this._unregisterUpdatableComponent(entity, component);
			this._callWorldLifecycleHandler(component, "onEntityRemoveFromWorld", entity);
		});
	}

	public notifyEntityComponentAdded(entity: Entity, component: Component): void {
		if (!this.entities.has(entity.id)) return;
		bumpWorldStructureVersion(this);
		this._indexEntityComponent(entity, component);
		this._recordComponentChange("add", entity, component);
		this._registerUpdatableComponent(entity, component);
		this._callWorldLifecycleHandler(component, "onEntityAddToWorld", entity);
	}

	public notifyEntityComponentRemoved(entity: Entity, component: Component): void {
		this._unindexEntityComponent(entity, component);
		this._unregisterUpdatableComponent(entity, component);
		if (!this.entities.has(entity.id)) return;
		bumpWorldStructureVersion(this);
		this._recordComponentChange("remove", entity, component);
		this._callWorldLifecycleHandler(component, "onEntityRemoveFromWorld", entity);
	}

	private _recordComponentChange(kind: WorldComponentChangeKind, entity: Entity, component: Component): void {
		let componentType: Function | null = component.constructor;
		while (componentType && componentType !== Function.prototype) {
			const journal = this._componentTypeChangeJournals.get(componentType);
			if (journal) this._recordComponentTypeChange(journal, kind, entity, component);
			if (componentType === Component) break;
			const proto = Object.getPrototypeOf(componentType.prototype);
			componentType = proto?.constructor ?? null;
		}
		this._componentChangeRevision = this._componentChangeRevision >= Number.MAX_SAFE_INTEGER
			? 1
			: this._componentChangeRevision + 1;
		const slot = (this._componentChangeRevision - 1) % COMPONENT_CHANGE_JOURNAL_CAPACITY;
		let change = this._componentChangeJournal[slot];
		if (!change) {
			change = { revision: this._componentChangeRevision, kind, entity, component };
			this._componentChangeJournal[slot] = change;
			return;
		}
		change.revision = this._componentChangeRevision;
		change.kind = kind;
		change.entity = entity;
		change.component = component;
	}

	private _recordComponentTypeChange(
		journal: ComponentTypeChangeJournal,
		kind: WorldComponentChangeKind,
		entity: Entity,
		component: Component,
	): void {
		const pending = journal.pendingByComponentId.get(component.id);
		if (
			kind === "update"
			&& pending
			&& pending.revision > journal.maxConsumedRevision
			&& (pending.kind === "add" || pending.kind === "update")
		) {
			pending.entity = entity;
			pending.component = component;
			return;
		}
		journal.revision = journal.revision >= Number.MAX_SAFE_INTEGER ? 1 : journal.revision + 1;
		const slot = (journal.revision - 1) % COMPONENT_CHANGE_JOURNAL_CAPACITY;
		let change = journal.changes[slot];
		if (!change) {
			change = { revision: journal.revision, kind, entity, component };
			journal.changes[slot] = change;
		} else {
			const previousPending = journal.pendingByComponentId.get(change.component.id);
			if (previousPending === change) journal.pendingByComponentId.delete(change.component.id);
			change.revision = journal.revision;
			change.kind = kind;
			change.entity = entity;
			change.component = component;
		}
		journal.pendingByComponentId.set(component.id, change);
	}

	private _getOrCreateComponentTypeJournal(componentType: Function): ComponentTypeChangeJournal {
		let journal = this._componentTypeChangeJournals.get(componentType);
		if (journal) return journal;
		journal = {
			revision: 0,
			maxConsumedRevision: 0,
			changes: [],
			pendingByComponentId: new Map(),
		};
		this._componentTypeChangeJournals.set(componentType, journal);
		return journal;
	}

	private _indexEntityComponents(entity: Entity): void {
		for (const component of entity.components.values()) this._indexEntityComponent(entity, component);
	}

	private _unindexEntityComponents(entity: Entity): void {
		for (const component of entity.components.values()) this._unindexEntityComponent(entity, component);
	}

	private _indexEntityComponent(entity: Entity, component: Component): void {
		let constructor: Function | null = component.constructor;
		while (constructor && constructor !== Function.prototype) {
			addEntityIndex(this._entitiesByComponentConstructor, constructor, entity);
			if (constructor === Component) break;
			const proto = Object.getPrototypeOf(constructor.prototype);
			constructor = proto?.constructor ?? null;
		}
		const symbol = component.UniqueSymbol as symbol | undefined;
		if (symbol) addEntityIndex(this._entitiesByComponentSymbol, symbol, entity);
	}

	private _unindexEntityComponent(entity: Entity, component: Component): void {
		let constructor: Function | null = component.constructor;
		while (constructor && constructor !== Function.prototype) {
			removeEntityIndex(this._entitiesByComponentConstructor, constructor, entity);
			if (constructor === Component) break;
			const proto = Object.getPrototypeOf(constructor.prototype);
			constructor = proto?.constructor ?? null;
		}
		const symbol = component.UniqueSymbol as symbol | undefined;
		if (symbol) removeEntityIndex(this._entitiesByComponentSymbol, symbol, entity);
	}

	private _getIndexedEntitiesForQueryToken(token: ComponentQueryToken): Set<Entity> | null {
		if (typeof token === "function") return this._entitiesByComponentConstructor.get(token) ?? null;
		if (typeof token === "symbol") return this._entitiesByComponentSymbol.get(token) ?? null;
		return null;
	}

	private _registerUpdatableComponent(entity: Entity, component: Component): void {
		if (!isUpdatableComponent(component)) return;
		let entities = this._updatableComponents.get(component);
		if (!entities) {
			entities = new Set();
			this._updatableComponents.set(component, entities);
		}
		entities.add(entity);
	}

	private _unregisterUpdatableComponent(entity: Entity, component: Component): void {
		if (!isUpdatableComponent(component)) return;
		const entities = this._updatableComponents.get(component);
		if (!entities) return;
		entities.delete(entity);
		if (entities.size === 0) this._updatableComponents.delete(component);
	}

	private _callWorldLifecycleHandler(
		component: Component,
		name: WorldLifecycleHandlerName,
		entity: Entity,
	): void {
		const flag = name === "onEntityAddToWorld"
			? ComponentLifecycleFlags.EntityAddToWorld
			: ComponentLifecycleFlags.EntityRemoveFromWorld;
		if (hasWorldLifecycleHandler(component, name, flag)) {
			component[name](entity, this);
		}
	}
}

function addEntityIndex(map: Map<Function | symbol, Set<Entity>>, key: Function | symbol, entity: Entity): void {
	let set = map.get(key);
	if (!set) {
		set = new Set();
		map.set(key, set);
	}
	set.add(entity);
}

function removeEntityIndex(map: Map<Function | symbol, Set<Entity>>, key: Function | symbol, entity: Entity): void {
	const set = map.get(key);
	if (!set) return;
	set.delete(entity);
	if (set.size === 0) map.delete(key);
}

function isUpdatableComponent(component: Component): component is UpdatableComponent {
	return (component.lifecycleFlags & ComponentLifecycleFlags.Update) !== 0
		&& typeof (component as { onUpdate?: unknown }).onUpdate === "function";
}

function hasWorldLifecycleHandler<T extends WorldLifecycleHandlerName>(
	component: Component,
	name: T,
	flag: number,
): component is Component & Record<T, (entity: Entity, world: World) => void> {
	return (component.lifecycleFlags & flag) !== 0
		&& typeof ((component as unknown) as Partial<Record<T, unknown>>)[name] === "function";
}
