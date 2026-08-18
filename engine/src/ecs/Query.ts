import type { AbstractComponentConstructor, Component } from './Component';
import type { Entity } from './Entity';

export type ComponentQueryToken = AbstractComponentConstructor<Component> | symbol | string;

export interface SystemQueryDescriptor {
	all?: readonly ComponentQueryToken[];
	any?: readonly ComponentQueryToken[];
	none?: readonly ComponentQueryToken[];
}

export function normalizeSystemQuery(query: SystemQueryDescriptor): Required<SystemQueryDescriptor> {
	return {
		all: query.all ?? [],
		any: query.any ?? [],
		none: query.none ?? [],
	};
}

export function matchesSystemQuery(entity: Entity, query: SystemQueryDescriptor): boolean {
	const normalized = normalizeSystemQuery(query);
	for (const token of normalized.all) {
		if (!entity.hasComponent(token)) return false;
	}
	if (normalized.any.length > 0) {
		let matched = false;
		for (const token of normalized.any) {
			if (entity.hasComponent(token)) {
				matched = true;
				break;
			}
		}
		if (!matched) return false;
	}
	for (const token of normalized.none) {
		if (entity.hasComponent(token)) return false;
	}
	return true;
}

export function isIndexableQueryToken(token: ComponentQueryToken): token is AbstractComponentConstructor<Component> | symbol {
	return typeof token === 'function' || typeof token === 'symbol';
}

export function getQueryTokenSymbol(token: ComponentQueryToken): symbol | null {
	if (typeof token === 'symbol') return token;
	if (typeof token === 'string') return Symbol.for(token);
	return null;
}
