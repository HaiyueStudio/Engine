import {
  assertPluginDependencies,
  EnginePluginInstallTracker,
  type EnginePlugin,
  type InstalledEnginePlugin,
  type PluginRuntimeContext,
} from './EnginePlugin';
import { EngineError, EngineErrorCode } from './EngineError';
import type { PluginLifecycleState } from './Lifecycle';
import { createGPUResourceOwner, type GPUResourceTracker } from './GPUResourceTracker';

export type EnginePluginHostScope = 'engine' | 'scene' | 'editor';

export interface EnginePluginHostOptions<TContext extends PluginRuntimeContext> {
  scope: EnginePluginHostScope;
  installHint: string;
  installDocsPath?: string;
  lifecycleHint?: string;
  createContext(tracker: EnginePluginInstallTracker): TContext;
  hasDependency(name: string): boolean;
  isDependencyEnabled?(name: string): boolean;
  onInstalled?(name: string, installed: InstalledEnginePlugin<TContext>): void;
  onUninstalled?(name: string, installed: InstalledEnginePlugin<TContext>): void;
  gpuResourceTracker?: GPUResourceTracker | undefined;
}

export class EnginePluginHost<TContext extends PluginRuntimeContext = PluginRuntimeContext> {
  private readonly _plugins = new Map<string, InstalledEnginePlugin<TContext>>();

  constructor(private readonly _options: EnginePluginHostOptions<TContext>) {}

  hasPlugin(name: string): boolean {
    return this._plugins.has(name);
  }

  isPluginEnabled(name: string): boolean {
    return this._plugins.get(name)?.enabled === true;
  }

  getPluginState(name: string): PluginLifecycleState | null {
    return this._plugins.get(name)?.state ?? null;
  }

  getPluginNames(): readonly string[] {
    return this._topologicalOrder();
  }

  installPlugin(plugin: EnginePlugin): this {
    if (this._plugins.has(plugin.name)) return this;
    this._assertNoDependencyCycle(plugin);
    assertPluginDependencies(plugin, this._options.hasDependency);
    const tracker = new EnginePluginInstallTracker();
    const context = this._options.createContext(tracker);
    const resourceOwner = this._options.gpuResourceTracker
      ? createGPUResourceOwner('plugin', `${this._options.scope}:${plugin.name}`)
      : undefined;
    try {
      this._withOwner(resourceOwner, () => this._install(plugin, context));
    } catch (error) {
      context.unregister();
      if (resourceOwner) this._options.gpuResourceTracker?.releaseOwner(resourceOwner);
      throw new EngineError(
        EngineErrorCode.PluginInstallFailed,
        `Failed to install plugin "${plugin.name}".`,
        {
          hint: this._options.installHint,
          docsPath: this._options.installDocsPath ?? 'errors/E_PLUGIN_INSTALL_FAILED',
          cause: error,
        },
      );
    }

    const installed: InstalledEnginePlugin<TContext> = { plugin, context, enabled: false, state: 'installed', resourceOwner };
    this._plugins.set(plugin.name, installed);
    this._options.onInstalled?.(plugin.name, installed);
    try {
      this.enablePlugin(plugin.name);
    } catch (error) {
      this._plugins.delete(plugin.name);
      try {
        this._withOwner(resourceOwner, () => this._uninstall(plugin, context));
      } finally {
        context.unregister();
        if (resourceOwner) this._options.gpuResourceTracker?.releaseOwner(resourceOwner);
        this._options.onUninstalled?.(plugin.name, installed);
      }
      throw error;
    }
    return this;
  }

  enablePlugin(name: string): this {
    this._enablePlugin(name, new Set());
    return this;
  }

  private _enablePlugin(name: string, visiting: Set<string>): void {
    const installed = this._plugins.get(name);
    if (!installed || installed.enabled) return;
    if (visiting.has(name)) {
      throw new EngineError(
        EngineErrorCode.PluginDependencyCycle,
        `Plugin dependency cycle detected while enabling "${name}".`,
        { context: { plugin: name, dependencyPath: [...visiting, name] } },
      );
    }
    visiting.add(name);
    for (const dependency of installed.plugin.dependencies ?? []) {
      if (this._plugins.has(dependency)) this._enablePlugin(dependency, visiting);
      else if (this._options.isDependencyEnabled?.(dependency) !== true) {
        this._throwDependencyNotEnabled(installed.plugin, dependency);
      }
    }
    try {
      this._withOwner(installed.resourceOwner, () => this._enable(installed.plugin, installed.context));
      installed.enabled = true;
      installed.state = 'enabled';
    } catch (error) {
      throw new EngineError(
        EngineErrorCode.PluginLifecycleFailed,
        `Failed to enable plugin "${name}".`,
        {
          hint: this._options.lifecycleHint ?? 'Check the plugin lifecycle implementation and dependency enabled state.',
          docsPath: 'errors/E_PLUGIN_LIFECYCLE_FAILED',
          cause: error,
        },
      );
    } finally {
      visiting.delete(name);
    }
  }

  disablePlugin(name: string): this {
    this._assertNoEnabledDependents(name);
    this._disablePlugin(name);
    return this;
  }

  private _disablePlugin(name: string): void {
    const installed = this._plugins.get(name);
    if (!installed || !installed.enabled) return;
    try {
      this._withOwner(installed.resourceOwner, () => this._disable(installed.plugin, installed.context));
      installed.enabled = false;
      installed.state = 'disabled';
    } catch (error) {
      throw new EngineError(
        EngineErrorCode.PluginLifecycleFailed,
        `Failed to disable plugin "${name}".`,
        {
          hint: `Check the plugin ${this._options.scope === 'engine' ? 'disableEngine()' : 'disableScene()'} implementation.`,
          docsPath: 'errors/E_PLUGIN_LIFECYCLE_FAILED',
          cause: error,
        },
      );
    }
  }

  removePlugin(name: string): this {
    this._assertNoDependents(name);
    this._removePlugin(name);
    return this;
  }

  private _removePlugin(name: string): void {
    const installed = this._plugins.get(name);
    if (!installed) return;
    try {
      this._disablePlugin(name);
      this._withOwner(installed.resourceOwner, () => this._uninstall(installed.plugin, installed.context));
    } finally {
      installed.context.unregister();
      if (installed.resourceOwner) this._options.gpuResourceTracker?.releaseOwner(installed.resourceOwner);
      this._plugins.delete(name);
      installed.enabled = false;
      installed.state = 'removed';
      this._options.onUninstalled?.(name, installed);
    }
  }

  clear(): void {
    for (const name of this._topologicalOrder().reverse()) this._removePlugin(name);
  }

  disableAll(): void {
    for (const name of this._topologicalOrder().reverse()) this._disablePlugin(name);
  }

  enableAll(): void {
    for (const name of this._topologicalOrder()) this._enablePlugin(name, new Set());
  }

  private _throwDependencyNotEnabled(plugin: EnginePlugin, dependency: string): never {
    throw new EngineError(
      EngineErrorCode.PluginLifecycleFailed,
      `Plugin "${plugin.name}" requires enabled dependency "${dependency}".`,
      {
        hint: 'Enable the dependency plugin before enabling this plugin.',
        docsPath: 'errors/E_PLUGIN_LIFECYCLE_FAILED',
        context: { plugin: plugin.name, dependency },
      },
    );
  }

  private _assertNoDependencyCycle(plugin: EnginePlugin): void {
    if ((plugin.dependencies ?? []).includes(plugin.name)) {
      throw new EngineError(
        EngineErrorCode.PluginDependencyCycle,
        `Plugin "${plugin.name}" cannot depend on itself.`,
        { context: { plugin: plugin.name, dependencyPath: [plugin.name, plugin.name] } },
      );
    }
    const plugins = new Map(this._plugins);
    plugins.set(plugin.name, { plugin } as InstalledEnginePlugin<TContext>);
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const path: string[] = [];
    const visit = (name: string): void => {
      if (visiting.has(name)) {
        const start = path.indexOf(name);
        throw new EngineError(
          EngineErrorCode.PluginDependencyCycle,
          `Plugin dependency cycle detected: ${[...path.slice(start), name].join(' -> ')}.`,
          { context: { plugin: plugin.name, dependencyPath: [...path.slice(start), name] } },
        );
      }
      if (visited.has(name)) return;
      const current = plugins.get(name);
      if (!current) return;
      visiting.add(name);
      path.push(name);
      for (const dependency of current.plugin.dependencies ?? []) visit(dependency);
      path.pop();
      visiting.delete(name);
      visited.add(name);
    };
    visit(plugin.name);
  }

  private _dependentsOf(name: string): string[] {
    return [...this._plugins.values()]
      .filter(installed => installed.plugin.dependencies?.includes(name))
      .map(installed => installed.plugin.name);
  }

  private _assertNoDependents(name: string): void {
    const dependents = this._dependentsOf(name);
    if (dependents.length === 0) return;
    throw new EngineError(
      EngineErrorCode.PluginDependencyInUse,
      `Plugin "${name}" is still required by: ${dependents.join(', ')}.`,
      { context: { plugin: name, dependents }, hint: 'Remove dependent plugins before removing their dependency.' },
    );
  }

  private _assertNoEnabledDependents(name: string): void {
    const dependents = this._dependentsOf(name).filter(dependent => this.isPluginEnabled(dependent));
    if (dependents.length === 0) return;
    throw new EngineError(
      EngineErrorCode.PluginDependencyInUse,
      `Plugin "${name}" has enabled dependents: ${dependents.join(', ')}.`,
      { context: { plugin: name, dependents }, hint: 'Disable dependent plugins first.' },
    );
  }

  private _topologicalOrder(): string[] {
    const order: string[] = [];
    const visited = new Set<string>();
    const visit = (name: string): void => {
      if (visited.has(name)) return;
      visited.add(name);
      const installed = this._plugins.get(name);
      if (!installed) return;
      for (const dependency of installed.plugin.dependencies ?? []) {
        if (this._plugins.has(dependency)) visit(dependency);
      }
      order.push(name);
    };
    for (const name of this._plugins.keys()) visit(name);
    return order;
  }

  private _withOwner<T>(owner: import('./GPUResourceTracker').GPUResourceOwner | undefined, action: () => T): T {
    return owner && this._options.gpuResourceTracker
      ? this._options.gpuResourceTracker.withOwner(owner, action)
      : action();
  }

  private _install(plugin: EnginePlugin, context: TContext): void {
    if (this._options.scope === 'engine') plugin.installEngine?.(context as Extract<TContext, { scope: 'engine' }>);
    else if (this._options.scope === 'scene') plugin.installScene?.(context as Extract<TContext, { scope: 'scene' }>);
    else plugin.installEditor?.(context as Extract<TContext, { scope: 'editor' }>);
  }

  private _uninstall(plugin: EnginePlugin, context: TContext): void {
    if (this._options.scope === 'engine') plugin.uninstallEngine?.(context as Extract<TContext, { scope: 'engine' }>);
    else if (this._options.scope === 'scene') plugin.uninstallScene?.(context as Extract<TContext, { scope: 'scene' }>);
    else plugin.uninstallEditor?.(context as Extract<TContext, { scope: 'editor' }>);
  }

  private _enable(plugin: EnginePlugin, context: TContext): void {
    if (this._options.scope === 'engine') plugin.enableEngine?.(context as Extract<TContext, { scope: 'engine' }>);
    else if (this._options.scope === 'scene') plugin.enableScene?.(context as Extract<TContext, { scope: 'scene' }>);
    else plugin.enableEditor?.(context as Extract<TContext, { scope: 'editor' }>);
  }

  private _disable(plugin: EnginePlugin, context: TContext): void {
    if (this._options.scope === 'engine') plugin.disableEngine?.(context as Extract<TContext, { scope: 'engine' }>);
    else if (this._options.scope === 'scene') plugin.disableScene?.(context as Extract<TContext, { scope: 'scene' }>);
    else plugin.disableEditor?.(context as Extract<TContext, { scope: 'editor' }>);
  }
}
