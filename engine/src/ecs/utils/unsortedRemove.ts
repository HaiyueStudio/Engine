export const unsortedRemove = <T>(arr: T[], i: number): T | undefined => {
	if (i >= arr.length || i < 0) {
		return;
	}

	const last = arr.pop() as T;
	if (i < arr.length) {
		const tmp = arr[i];
		arr[i] = last;
		return tmp;
	}

	return last;
};

export const unsortedRemoveValue = <T>(arr: T[], value: T): T | undefined => {
	return unsortedRemove(arr, arr.indexOf(value));
};
