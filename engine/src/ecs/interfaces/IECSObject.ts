export interface IECSObject<UsedByObj> {
	id: number;
	disabled: boolean;
	name: string;
	usedBy: UsedByObj[];
	UniqueSymbol?: symbol;
}
