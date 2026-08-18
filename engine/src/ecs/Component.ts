import type { Entity } from "./Entity";
import { EcsIds } from "./Global";
import type { IECSObject } from "./interfaces/IECSObject";
import type { ComponentSerialization } from "./interfaces/serialization";
import { deepClone } from "../utils/deepClone";
import { EngineError, EngineErrorCode } from "../core/EngineError";

// 一些组件不需要添加多个。如果add多个一样组件，会依据规则只保留最新的
export enum UniqueCheckType {
	NO = 0, // 不判断是否重复
	SAME = 0b00001, // 如果类一致，则保留最新的
	CHILD = 0b00010, // 判断新组件与老组件是否构成继承关系，新组件是子类
	SUPER = 0b00100, // 判断新组件与老组件是否构成继承关系，新组件是父类
	SYMBOL= 0b01000, // unique symbol是否一致，最常用
	REPLACE = 0b10000, // 校验后，1为替换老组件，0为保留原组件
}

export const ComponentLifecycleFlags = {
	None: 0,
	EntityAddComponent: 1 << 0,
	EntityRemoveComponent: 1 << 1,
	EntityAddToWorld: 1 << 2,
	EntityRemoveFromWorld: 1 << 3,
	Update: 1 << 4,
} as const;

export class Component implements IECSObject<Entity> {
	public static UniqueCheckType = UniqueCheckType.NO; // 默认不检查，可以随意添加多个一样的组件
	public static UniqueSymbol = Symbol.for("Base");
	public static Lifecycle: number = ComponentLifecycleFlags.None;
	public readonly isComponent = true;
	public readonly id = EcsIds.component.next();
	private _disabled = false;
	public destroyed = false;
	public name: string;
	public usedBy: Entity[] = [];
	public readonly UniqueSymbol = (this.constructor as typeof Component).UniqueSymbol;
	public readonly UniqueCheckType = (this.constructor as typeof Component).UniqueCheckType;
	public readonly lifecycleFlags = (this.constructor as typeof Component).Lifecycle;

	public static unserialize(json: ComponentSerialization) {
		const obj = new this();
		obj.name = json.name ?? obj.name;
		obj.disabled = json.disabled ?? false;

		return obj;
	}

	public constructor(name: string = "Untitled Component") {
		this.name = name;
	}

	public get disabled(): boolean { return this._disabled; }
	public set disabled(value: boolean) {
		const next = Boolean(value);
		if (this._disabled === next) return;
		this._disabled = next;
		for (const entity of this.usedBy) entity.world?.notifyEntityComponentChanged(entity, this);
	}

	public clone(): Component {
		return new Component(this.name);
	}

	public destroy() {
		if (this.destroyed) return;
		this.destroyed = true;
		if (this.usedBy.length === 1) {
			this.usedBy[0]?.remove(this);
		} else {
			for (const manager of [...this.usedBy]) {
				manager.remove(this);
			}
		}
		this.usedBy.length = 0;
	}
}

export interface ComponentAddLifecycle {
	onEntityAddComponent(entity: Entity, component: Component): void;
}

export interface ComponentRemoveLifecycle {
	onEntityRemoveComponent(entity: Entity, component: Component): void;
}

export interface ComponentWorldLifecycle {
	onEntityAddToWorld?(entity: Entity, world: import("./World").World): void;
	onEntityRemoveFromWorld?(entity: Entity, world: import("./World").World): void;
}

export interface ComponentUpdateLifecycle {
	onUpdate(entity: Entity, time: number, delta: number, world: import("./World").World): void;
}

export class ComponentWithData<DataType> extends Component {
	public data: DataType;

	public static override unserialize(json: ComponentSerialization) {
		const Ctor = this as unknown as new (data: unknown, name?: string) => ComponentWithData<unknown>;
		const obj = new Ctor(json.data, json.name);
		obj.disabled = json.disabled ?? false;
		return obj;
	}

	public constructor(data: DataType, name: string = "Untitled Component") {
		super(name);
		this.data = data;
	}

	public clone(): ComponentWithData<DataType> {
		if (this.constructor !== ComponentWithData) {
			throw new EngineError(
				EngineErrorCode.ComponentCloneUnsupported,
				`${this.constructor.name}.clone() must be implemented explicitly.`,
				{
					hint: "Components with data may hold engine resources or typed arrays; implement clone() on the concrete component to define ownership.",
					docsPath: "errors/E_COMPONENT_CLONE_UNSUPPORTED",
				},
			);
		}
		return new ComponentWithData(deepClone(this.data), this.name);
	}
}

export type ComponentConstructor<TArgs extends unknown[] = never[]> = new (...args: TArgs) => Component;
export type AbstractComponentConstructor<T extends Component = Component, TArgs extends unknown[] = never[]> = abstract new (...args: TArgs) => T;
