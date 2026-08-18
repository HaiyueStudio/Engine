import { IECSObject } from "../interfaces/IECSObject";
import { unsortedRemoveValue } from "./unsortedRemove";

type AbstractConstructor<T> = abstract new (...args: never[]) => T;
interface ManagerIndices<T> {
	names: Map<string, Set<number>>;
	symbols: Map<symbol, Set<number>>;
	constructors: Map<Function, Set<number>>;
}

const managerIndices = new WeakMap<Map<number, IECSObject<unknown>>, ManagerIndices<IECSObject<unknown>>>();

export const add = <U, T extends IECSObject<U>>(element: T, map: Map<number, T>, owner: U): boolean => {
	if (has(map, element)) {
		return false;
	}

	map.set(element.id, element);
	const indices = managerIndices.get(map as Map<number, IECSObject<unknown>>) as ManagerIndices<T> | undefined;
	if (indices) indexElement(indices, element);
	element.usedBy.push(owner);

	return true;
};

export const clear = <U, T extends IECSObject<U>>(map: Map<number, T>, owner: U) => {
	const arr = Array.from(map);

	for (let element of arr) {
		remove(map, element[1], owner);
	}

	return owner;
};

export const get = <U, T extends IECSObject<U>>(
	map: Map<number, T>,
	name: string | number | AbstractConstructor<T> | symbol,
	strict = false,
): T | null => {
	if (typeof name === "number") {
		return map.get(name) ?? null;
	}
	if (typeof name === "function") {
		const exact = getFirstByConstructor(map, getIndices(map).constructors.get(name), name, strict);
		if (exact) return exact;
		if (!strict) return scanAndIndexByConstructor(map, name);
		return null;
	}
	if (typeof name === "symbol") {
		return getFirstBySymbol(map, getIndices(map).symbols.get(name), name);
	}
	if (typeof name === "string") {
		const indices = getIndices(map);
		const byName = getFirstByName(map, indices.names.get(name), name);
		if (byName) return byName;
		const symbol = Symbol.for(name);
		const bySymbol = getFirstBySymbol(map, indices.symbols.get(symbol), symbol);
		if (bySymbol) return bySymbol;
		return scanAndIndexByNameOrSymbol(map, name, symbol);
	}

	return null;
};

export const has = <U, T extends IECSObject<U>>(
	map: Map<number, T>,
	element: T | number | string | AbstractConstructor<T> | symbol,
	strict = false,
): boolean => {
	if (typeof element === "number") {
		return map.has(element);
	} else if (typeof element === "string") {
		return get(map, element) !== null;
	} else if (typeof element === "function") {
		return get(map, element, strict) !== null;
	} else if (typeof element === "symbol") {
		return get(map, element) !== null;
	}  else {
		return map.has((element as T).id);
	}
};

export const remove = <U, T extends IECSObject<U>>(
	map: Map<number, T>,
	element: T | string | number | AbstractConstructor<T> | symbol,
	owner: U,
	strict = false,
): T | null => {
	let elementTmp: T | undefined;
	if (typeof element === "number" || typeof element === "string" || typeof element === "symbol") {
		elementTmp = get(map, element) ?? undefined;
	} else if (typeof element === "function") {
		elementTmp = get(map, element, strict) ?? undefined;
	} else {
		elementTmp = map.get(element.id);
	}

	if (elementTmp) {
		const indices = managerIndices.get(map as Map<number, IECSObject<unknown>>) as ManagerIndices<T> | undefined;
		if (indices) unindexElement(indices, elementTmp);
		map.delete(elementTmp.id);
		unsortedRemoveValue(elementTmp.usedBy, owner);

		return elementTmp;
	}

	return null;
};

function getIndices<T extends IECSObject<unknown>>(map: Map<number, T>): ManagerIndices<T> {
	let indices = managerIndices.get(map as Map<number, IECSObject<unknown>>) as ManagerIndices<T> | undefined;
	if (!indices) {
		indices = {
			names: new Map(),
			symbols: new Map(),
			constructors: new Map(),
		};
		managerIndices.set(map as Map<number, IECSObject<unknown>>, indices as ManagerIndices<IECSObject<unknown>>);
		for (const item of map.values()) indexElement(indices, item);
	}
	return indices;
}

function indexElement<T extends IECSObject<unknown>>(indices: ManagerIndices<T>, item: T): void {
	addIndex(indices.names, item.name, item.id);
	if (item.UniqueSymbol) addIndex(indices.symbols, item.UniqueSymbol, item.id);
	addIndex(indices.constructors, item.constructor, item.id);
}

function unindexElement<T extends IECSObject<unknown>>(indices: ManagerIndices<T>, item: T): void {
	removeIndex(indices.names, item.name, item.id);
	if (item.UniqueSymbol) removeIndex(indices.symbols, item.UniqueSymbol, item.id);
	removeIndex(indices.constructors, item.constructor, item.id);
}

function addIndex<K>(map: Map<K, Set<number>>, key: K, id: number): void {
	let ids = map.get(key);
	if (!ids) {
		ids = new Set();
		map.set(key, ids);
	}
	ids.add(id);
}

function removeIndex<K>(map: Map<K, Set<number>>, key: K, id: number): void {
	const ids = map.get(key);
	if (!ids) return;
	ids.delete(id);
	if (ids.size === 0) map.delete(key);
}

function getFirstByConstructor<T extends IECSObject<unknown>>(
	map: Map<number, T>,
	ids: Set<number> | undefined,
	constructor: AbstractConstructor<T>,
	strict: boolean,
): T | null {
	if (!ids) return null;
	for (const id of ids) {
		const item = map.get(id);
		if (item && (strict ? item.constructor === constructor : item instanceof constructor)) return item;
		ids.delete(id);
	}
	return null;
}

function getFirstBySymbol<T extends IECSObject<unknown>>(
	map: Map<number, T>,
	ids: Set<number> | undefined,
	symbol: symbol,
): T | null {
	if (!ids) return null;
	for (const id of ids) {
		const item = map.get(id);
		if (item?.UniqueSymbol === symbol) return item;
		ids.delete(id);
	}
	return null;
}

function getFirstByName<T extends IECSObject<unknown>>(
	map: Map<number, T>,
	ids: Set<number> | undefined,
	name: string,
): T | null {
	if (!ids) return null;
	for (const id of ids) {
		const item = map.get(id);
		if (item?.name === name) return item;
		ids.delete(id);
	}
	return null;
}

function scanAndIndexByConstructor<T extends IECSObject<unknown>>(
	map: Map<number, T>,
	constructor: AbstractConstructor<T>,
): T | null {
	for (const item of map.values()) {
		if (!(item instanceof constructor)) continue;
		return item;
	}
	return null;
}

function scanAndIndexByNameOrSymbol<T extends IECSObject<unknown>>(
	map: Map<number, T>,
	name: string,
	symbol: symbol,
): T | null {
	for (const item of map.values()) {
		if (item.name !== name && item.UniqueSymbol !== symbol) continue;
		return item;
	}
	return null;
}
