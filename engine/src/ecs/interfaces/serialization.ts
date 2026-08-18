export type ECSObjectSerialization = {
    id: number;
    name?: string;
    disabled?: boolean;
    className?: string;
}

export type WorldSerialization = {
    rootEntities?: number[];
    systems?: number[];
} & ECSObjectSerialization;

export type EntitySerialization = {
    components?: number[];
    children?: number[];
} & ECSObjectSerialization;

export type SystemSerialization = {
    priority?: number;
} & ECSObjectSerialization;

export type ComponentSerialization = {
    data?: unknown;
} & ECSObjectSerialization;

export type ECSAppSerialization = {
    worlds?: WorldSerialization[];
    entities?: EntitySerialization[];
    system?: SystemSerialization[];
    components?: ComponentSerialization[];
}
