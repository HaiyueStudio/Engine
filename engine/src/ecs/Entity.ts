import { EcsIds } from "./Global";
import {
	type AbstractComponentConstructor,
	Component,
	type ComponentAddLifecycle,
	type ComponentConstructor,
	ComponentLifecycleFlags,
	type ComponentRemoveLifecycle,
	UniqueCheckType,
} from "./Component";
import type { World } from "./World";
import type { IECSObject } from "./interfaces/IECSObject";
import { add, clear, get, has, remove } from "./utils/ecsManagerOperations";
import { getEntitiesCache } from "./cache";
import type { EntitySerialization } from "./interfaces/serialization";
import { unsortedRemoveValue } from "./utils/unsortedRemove";
import { EngineError, EngineErrorCode } from "../core/EngineError";

export type EntityConstructor<TArgs extends unknown[] = never[]> = new (...args: TArgs) => Entity;
type ComponentAddLifecycleHandler = Component & ComponentAddLifecycle;
type ComponentRemoveLifecycleHandler = Component & ComponentRemoveLifecycle;
type ComponentLifecycleEvent = {
	type: "add" | "remove";
	component: Component;
};

export class Entity implements IECSObject<World> {
	public static tagSet: Map<string, Set<ComponentConstructor>> = new Map();

	public static setTag(name: string, components: Array<ComponentConstructor | string> | Set<ComponentConstructor | string>) {
		const set = new Set<ComponentConstructor>();
		Entity.tagSet.set(name, set);
		components.forEach((val) => {
			if (val instanceof Object) {
				set.add(val);
			} else {
				Entity.tagSet.get(val)?.forEach((ele) => {
					set.add(ele);
				});
			}
		});
	}

	public static removeTag(name: string) {
		Entity.tagSet.delete(name);
	}

	static unserialize(json: EntitySerialization) {
		const obj = new this(json.name);
		obj.disabled = json.disabled ?? false;

		return obj;
	}

	public readonly id: number = EcsIds.entity.next();
	public readonly isEntity = true;
	public destroyed = false;
	public readonly components = new Map<number, Component>();
	private _disabled = false;
	private _parent: Entity | null = null;
	public hierarchyVersion = 0;
	public name: string;
	public readonly usedBy: World[] = [];
	public children: Entity[] = [];
	private readonly _componentsByConstructor = new Map<Function, Set<Component>>();
	private readonly _componentsBySymbol = new Map<symbol, Set<Component>>();
	private readonly _componentLookupCache = new Map<Function | symbol, Component | null>();
	private readonly _componentAddCallbackComponents = new Set<ComponentAddLifecycleHandler>();
	private readonly _componentRemoveCallbackComponents = new Set<ComponentRemoveLifecycleHandler>();
	private readonly _componentLifecycleQueue: ComponentLifecycleEvent[] = [];
	private _componentLifecycleQueueCursor = 0;
	private _flushingComponentLifecycleQueue = false;

	public constructor(name = "Untitled Entity") {
		this.name = name;
	}

	public get parent(): Entity | null {
		return this._parent;
	}

	/** The single World that owns this entity, or null while it is detached. */
	public get world(): World | null {
		return this.usedBy[0] ?? null;
	}

	public set parent(value: Entity | null) {
		if (this._parent === value) return;
		if (this.destroyed && value !== null) throw entityDestroyedError(this);
		if (value?.destroyed) throw entityDestroyedError(value);
		const currentWorld = this.world;
		const parentWorld = value?.world ?? null;
		if (currentWorld && value && parentWorld !== currentWorld) {
			throw hierarchyWorldConflictError(this, value);
		}
		this._parent = value;
		this._markHierarchyStateDirty();
		for (const world of this.usedBy) {
			world.updateRootEntity(this);
			world.notifyEntityHierarchyChanged(this);
		}
	}

	public get disabled(): boolean {
		return this._disabled;
	}

	public set disabled(value: boolean) {
		if (this._disabled === value) return;
		this._disabled = value;
		this._markHierarchyStateDirty();
	}

	public add<T extends EntityConstructor>(child: T, ...args: ConstructorParameters<T>): this;
	public add<T extends ComponentConstructor>(componentOrChild: T, ...args: ConstructorParameters<T>): this;
	public add(componentOrChild: Component | Entity): this;
	public add(
		componentOrChild: Component | Entity | ComponentConstructor | EntityConstructor,
		...args: unknown[]
	): this {
		if (componentOrChild instanceof Entity) {
			return this.addChild(componentOrChild);
		}
		if (componentOrChild instanceof Component) {
			return this.addComponent(componentOrChild);
		}

		const Constructor = componentOrChild as new (...constructorArgs: unknown[]) => Component | Entity;
		return this.add(new Constructor(...args));
	}

	public addComponent(component: Component): this;
	public addComponent<T extends ComponentConstructor>(
		componentOrChild: T,
		...args: ConstructorParameters<T>
	): this;
	public addComponent(
		component: Component | ComponentConstructor,
		...args: ConstructorParameters<ComponentConstructor>
	): this {
		if (this.destroyed) throw entityDestroyedError(this);
		let comp: Component = component instanceof Component ? component : new component(...args);
		const unique = (comp.constructor as typeof Component).UniqueCheckType;
		const sameOnlyUnique = (unique & UniqueCheckType.SAME) && !(unique & (UniqueCheckType.SYMBOL | UniqueCheckType.CHILD | UniqueCheckType.SUPER));
		if (unique & UniqueCheckType.SYMBOL) {
			const existing = this._getComponentBySymbol((comp.constructor as typeof Component).UniqueSymbol);
			if (existing) {
				if (unique & UniqueCheckType.REPLACE) {
					this._detachComponent(existing);
				} else {
					return this;
				}
			}
		} else if (sameOnlyUnique) {
			const existing = this._getComponentByConstructor(comp.constructor);
			if (existing) {
				if (unique & UniqueCheckType.REPLACE) {
					this._detachComponent(existing);
				} else {
					return this;
				}
			}
		} else {
			for (let [_, c] of this.components) {
				if (
					unique & UniqueCheckType.CHILD && comp instanceof c.constructor ||
					unique & UniqueCheckType.SUPER && c instanceof comp.constructor ||
					unique & UniqueCheckType.SAME && c.constructor === comp.constructor
				) {
					if (unique & UniqueCheckType.REPLACE) {
						this._detachComponent(c);
					} else {
						return this;
					}
				}
			}
		}

		let result: boolean;
		result = add(comp, this.components, this as Entity);

		if (result) {
			this._indexComponent(comp);
			for (const world of this.usedBy) {
				getEntitiesCache(world).add(this);
			}
			this._notifyComponentAdded(comp);
			this._notifyWorldsComponentAdded(comp);
		}

		return this;
	}

	private _detachComponent(component: Component): void {
		if (!this.components.delete(component.id)) return;
		this._unindexComponent(component);
		this._notifyComponentRemoved(component);
		this._notifyWorldsComponentRemoved(component);
		unsortedRemoveValue(component.usedBy, this);
	}

	private _indexComponent(component: Component): void {
		this._componentLookupCache.clear();
		const constructor = component.constructor;
		let set = this._componentsByConstructor.get(constructor);
		if (!set) {
			set = new Set();
			this._componentsByConstructor.set(constructor, set);
		}
		set.add(component);
		const symbol = component.UniqueSymbol as symbol | undefined;
		if (symbol) {
			let symbolSet = this._componentsBySymbol.get(symbol);
			if (!symbolSet) {
				symbolSet = new Set();
				this._componentsBySymbol.set(symbol, symbolSet);
			}
			symbolSet.add(component);
		}
		if (hasAddComponentLifecycleHandler(component)) {
			this._componentAddCallbackComponents.add(component);
		}
		if (hasRemoveComponentLifecycleHandler(component)) {
			this._componentRemoveCallbackComponents.add(component);
		}
	}

	private _unindexComponent(component: Component): void {
		this._componentLookupCache.clear();
		const constructor = component.constructor;
		const set = this._componentsByConstructor.get(constructor);
		if (set) {
			set.delete(component);
			if (set.size === 0) this._componentsByConstructor.delete(constructor);
		}
		const symbol = component.UniqueSymbol as symbol | undefined;
		if (symbol) {
			const symbolSet = this._componentsBySymbol.get(symbol);
			if (symbolSet) {
				symbolSet.delete(component);
				if (symbolSet.size === 0) this._componentsBySymbol.delete(symbol);
			}
		}
		if (hasAddComponentLifecycleHandler(component)) this._componentAddCallbackComponents.delete(component);
		if (hasRemoveComponentLifecycleHandler(component)) this._componentRemoveCallbackComponents.delete(component);
	}

	private _getComponentByConstructor(constructor: Function): Component | null {
		const set = this._componentsByConstructor.get(constructor);
		return set?.values().next().value ?? null;
	}

	private _getComponentBySymbol(symbol: symbol): Component | null {
		const set = this._componentsBySymbol.get(symbol);
		return set?.values().next().value ?? null;
	}

	public addChild<T extends EntityConstructor>(entity: T, ...args: ConstructorParameters<T>): this;
	public addChild(entity: Entity): this;
	public addChild<T extends EntityConstructor>(entity: Entity | T, ...args: ConstructorParameters<T>): this {
		if (this.destroyed) throw entityDestroyedError(this);
		const e = entity instanceof Entity ? entity : new entity(...args);
		if (e.destroyed) throw entityDestroyedError(e);
		if (e === this || e.isAncestorOf(this)) return this;
		const parentWorld = this.world;
		const childWorld = e.world;
		if (childWorld && childWorld !== parentWorld) {
			throw hierarchyWorldConflictError(e, this);
		}

		if (e.parent && e.parent !== this) {
			e.parent._removeChildReference(e);
			e.parent = null;
		}

		if (parentWorld && !childWorld) parentWorld.addEntity(e);
		if (!this.children.includes(e)) {
			this.children.push(e);
		}
		e.parent = this;
		for (const world of this.usedBy) {
			world.updateRootEntity(e);
		}
		e._markHierarchyStateDirty();
		return this;
	}

	public clone(cloneComponents?: boolean, includeChildren?: boolean) {
		const entity = new (this.constructor as new (name?: string) => Entity)(this.name);
		if (cloneComponents) {
			this.components.forEach((component) => {
				entity.addComponent(component.clone());
			});
		} else {
			this.components.forEach((component) => {
				entity.addComponent(component);
			});
		}
		if (!includeChildren) {
			return entity;
		}
		for (const child of this.children) {
			entity.addChild(child.clone(cloneComponents, includeChildren));
		}
		return entity;
	}

	public destroy(): this {
		if (this.destroyed) return this;
		if (this.children.length === 0) {
			this.destroyed = true;
			this.world?.removeEntity(this);
			const previousParent = this._parent;
			previousParent?._removeChildReference(this);
			this._parent = null;
			this.hierarchyVersion++;
			this._destroyComponents();
			return this;
		}

		const hierarchy: Entity[] = [];
		const pending: Entity[] = [this];
		const visited = new Set<Entity>();
		while (pending.length > 0) {
			const entity = pending.pop();
			if (!entity || visited.has(entity)) continue;
			visited.add(entity);
			hierarchy.push(entity);
			for (let i = entity.children.length - 1; i >= 0; i--) {
				const child = entity.children[i];
				if (child) pending.push(child);
			}
		}

		// Mark the complete subtree before lifecycle callbacks can re-enter destroy().
		for (const entity of hierarchy) entity.destroyed = true;

		// World removal keeps components alive long enough to emit remove-from-world callbacks.
		for (const entity of hierarchy) entity.world?.removeEntity(entity);

		const previousParent = this._parent;
		previousParent?._removeChildReference(this);
		for (const entity of hierarchy) {
			entity._parent = null;
			entity.children.length = 0;
			entity.hierarchyVersion++;
		}

		// Children are finalized before their parents, matching tree resource ownership.
		for (let i = hierarchy.length - 1; i >= 0; i--) {
			const entity = hierarchy[i];
			if (entity) entity._destroyComponents();
		}

		return this;
	}

	private _destroyComponents(): void {
		if (this.components.size === 1) {
			this.components.values().next().value?.destroy();
		} else {
			for (const component of [...this.components.values()]) component.destroy();
		}
		this._componentsByConstructor.clear();
		this._componentsBySymbol.clear();
		this._componentAddCallbackComponents.clear();
		this._componentRemoveCallbackComponents.clear();
		this._componentLifecycleQueue.length = 0;
		this._componentLifecycleQueueCursor = 0;
		this._flushingComponentLifecycleQueue = false;
		if (this.components.size > 0) clear(this.components, this as Entity);
	}

	public fitTag(tag: string, strict?: boolean) {
		const compClass = Entity.tagSet.get(tag);

		if (!compClass) {
			return;
		}

		compClass.forEach((val) => {
			if (!this.hasComponent(val, strict)) {
				this.add(val);
			}
		});

		return this;
	}

	public getComponent<T extends Component>(nameOrId: AbstractComponentConstructor<T>, strict?: boolean): T | null;
	public getComponent<T extends Component = Component>(nameOrId: string | number | symbol): T | null;
	public getComponent<T extends Component>(nameOrId: AbstractComponentConstructor<T> | string | number | symbol, strict?: boolean): Component | null {
		if (!strict && (typeof nameOrId === "function" || typeof nameOrId === "symbol")) {
			if (this._componentLookupCache.has(nameOrId)) return this._componentLookupCache.get(nameOrId) ?? null;
			const component = get(this.components, nameOrId, false);
			this._componentLookupCache.set(nameOrId, component);
			return component;
		}
		return get(this.components, nameOrId, strict);
	}

	public hasComponent(component: Component | string | number | AbstractComponentConstructor | symbol, strict?: boolean): boolean {
		if (typeof component === "function" || typeof component === "symbol") {
			return this.getComponent(component as AbstractComponentConstructor, strict) !== null;
		}
		return has(this.components, component, strict);
	}

	public isFitTag(name: string, strict?: boolean) {
		const tags = Entity.tagSet.get(name);

		if (!tags) {
			return false;
		}

		for (const item of tags) {
			if (!this.hasComponent(item, strict)) {
				return false;
			}
		}

		return true;
	}

	public remove(entityOrComponent: Entity | Component | AbstractComponentConstructor | symbol, strict?: boolean) {
		if (entityOrComponent instanceof Entity) {
			return this.removeChild(entityOrComponent);
		}

		return this.removeComponent(entityOrComponent, strict);
	}

	public removeChild(entity: Entity): this {
		for (const world of this.usedBy) {
			world.removeEntity(entity);
		}

		this._removeChildReference(entity);
		if (entity.parent === this) entity.parent = null;
		entity._markHierarchyStateDirty();
		return this;
	}

	public isAncestorOf(entity: Entity): boolean {
		let current = entity.parent;
		while (current) {
			if (current === this) return true;
			current = current.parent;
		}
		return false;
	}

	private _removeChildReference(entity: Entity): void {
		const index = this.children.indexOf(entity);
		if (index >= 0) {
			this.children.splice(index, 1);
		}
	}

	public removeComponent(component: Component | string | AbstractComponentConstructor | symbol, strict?: boolean): this {
		const removed = remove(this.components, component, this as Entity, strict);
		if (removed) {
			this._unindexComponent(removed);
			this._notifyComponentRemoved(removed);
			this._notifyWorldsComponentRemoved(removed);
			for (const world of this.usedBy) {
				getEntitiesCache(world).add(this);
			}
		}
		return this;
	}

	private _notifyComponentAdded(component: Component): void {
		this._enqueueComponentLifecycleEvent("add", component);
	}

	private _notifyComponentRemoved(component: Component): void {
		this._enqueueComponentLifecycleEvent("remove", component);
	}

	private _enqueueComponentLifecycleEvent(type: ComponentLifecycleEvent["type"], component: Component): void {
		this._componentLifecycleQueue.push({ type, component });
		if (!this._flushingComponentLifecycleQueue) this._flushComponentLifecycleQueue();
	}

	private _flushComponentLifecycleQueue(): void {
		this._flushingComponentLifecycleQueue = true;
		try {
			while (this._componentLifecycleQueueCursor < this._componentLifecycleQueue.length) {
				const event = this._componentLifecycleQueue[this._componentLifecycleQueueCursor++];
				if (!event) throw new Error("Component lifecycle queue contains an empty slot.");
				if (event.type === "add") {
					for (const item of this._componentAddCallbackComponents) {
						item.onEntityAddComponent(this, event.component);
					}
				} else {
					for (const item of this._componentRemoveCallbackComponents) {
						item.onEntityRemoveComponent(this, event.component);
					}
					if (hasRemoveComponentLifecycleHandler(event.component)) {
						event.component.onEntityRemoveComponent(this, event.component);
					}
				}
			}
		} finally {
			this._componentLifecycleQueue.length = 0;
			this._componentLifecycleQueueCursor = 0;
			this._flushingComponentLifecycleQueue = false;
		}
	}

	private _notifyWorldsComponentAdded(component: Component): void {
		for (const world of this.usedBy) {
			world.notifyEntityComponentAdded(this, component);
		}
	}

	private _notifyWorldsComponentRemoved(component: Component): void {
		for (const world of this.usedBy) {
			world.notifyEntityComponentRemoved(this, component);
		}
	}

	private _markHierarchyStateDirty(): void {
		this.world?.frameData.transforms.markDirty(this);
		const pending: Entity[] = [this];
		const visited = new Set<Entity>();
		while (pending.length > 0) {
			const entity = pending.pop();
			if (!entity || visited.has(entity)) continue;
			visited.add(entity);
			entity.hierarchyVersion++;
			for (const child of entity.children) pending.push(child);
		}
	}
}

function entityDestroyedError(entity: Entity): EngineError {
	return new EngineError(
		EngineErrorCode.EcsEntityDestroyed,
		`Entity "${entity.name}" (${entity.id}) has been destroyed.`,
		{ context: { entityId: entity.id, entityName: entity.name } },
	);
}

function hierarchyWorldConflictError(entity: Entity, parent: Entity): EngineError {
	return new EngineError(
		EngineErrorCode.EcsWorldOwnershipConflict,
		`Entity "${entity.name}" and parent "${parent.name}" must belong to the same World.`,
		{
			context: {
				entityId: entity.id,
				entityWorldId: entity.world?.id ?? null,
				parentId: parent.id,
				parentWorldId: parent.world?.id ?? null,
			},
			hint: "Use World.transferEntity(entity) before reparenting across Worlds.",
		},
	);
}

function hasAddComponentLifecycleHandler(component: Component): component is ComponentAddLifecycleHandler {
	return (component.lifecycleFlags & ComponentLifecycleFlags.EntityAddComponent) !== 0
		&& typeof (component as { onEntityAddComponent?: unknown }).onEntityAddComponent === "function";
}

function hasRemoveComponentLifecycleHandler(component: Component): component is ComponentRemoveLifecycleHandler {
	return (component.lifecycleFlags & ComponentLifecycleFlags.EntityRemoveComponent) !== 0
		&& typeof (component as { onEntityRemoveComponent?: unknown }).onEntityRemoveComponent === "function";
}
