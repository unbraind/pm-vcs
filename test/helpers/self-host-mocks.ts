/** Replace writable built-in module methods in both Node and Bun test processes. */
export class ModuleMocks {
  private readonly undo: (() => void)[] = [];

  /** Retain and restore the exact original property descriptor. */
  method(target: object, key: PropertyKey, replacement: unknown): void {
    const descriptor = Object.getOwnPropertyDescriptor(target, key)!;
    Object.defineProperty(target, key, { ...descriptor, value: replacement });
    this.undo.push(() => Object.defineProperty(target, key, descriptor));
  }

  /** Restore nested replacements in reverse order. */
  restoreAll(): void {
    for (const restore of this.undo.splice(0).reverse()) restore();
  }
}
