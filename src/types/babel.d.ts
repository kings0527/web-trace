// Type declarations for Babel modules without bundled types

declare module '@babel/traverse' {
  import type { Node } from '@babel/types';

  interface TraversalContext {
    node: Node;
    parent: Node;
    parentPath: NodePath<Node>;
    scope: any;
  }

  interface NodePath<T = Node> {
    node: T;
    parent: Node;
    parentPath: NodePath<Node> | null;
    scope: any;
    type: string;

    // Property access
    get(key: string): NodePath | NodePath[];

    // Traversal
    findParent(predicate: (path: NodePath) => boolean): NodePath | null;
    find(predicate: (path: NodePath) => boolean): NodePath | null;
    getFunctionParent(): NodePath | null;

    // Type guards
    isWhileStatement(): boolean;
    isForStatement(): boolean;
    isIfStatement(): boolean;
    isSwitchStatement(): boolean;
    isBlockStatement(): boolean;
    isExpressionStatement(): boolean;
    isFunctionDeclaration(): boolean;
    isVariableDeclaration(): boolean;
    isIdentifier(): boolean;

    // Modification
    replaceWith(node: Node): void;
    replaceWithMultiple(nodes: Node[]): void;
    remove(): void;
    insertBefore(nodes: Node | Node[]): void;
    insertAfter(nodes: Node | Node[]): void;

    // Control
    stop(): void;
    skip(): void;
  }

  type Visitor = {
    [K: string]: ((path: NodePath<any>, state?: any) => void) | {
      enter?: (path: NodePath<any>, state?: any) => void;
      exit?: (path: NodePath<any>, state?: any) => void;
    };
  };

  function traverse(ast: Node, visitor: Visitor, scope?: any, state?: any): void;
  export default traverse;
  export { NodePath, Visitor, TraversalContext };
}

declare module '@babel/parser' {
  import type { File } from '@babel/types';

  export interface ParserOptions {
    sourceType?: 'script' | 'module' | 'unambiguous';
    plugins?: string[];
    errorRecovery?: boolean;
  }

  export type ParseResult = File & {
    errors?: any[];
  };

  export function parse(code: string, options?: ParserOptions): ParseResult;
}

declare module '@babel/generator' {
  import type { Node } from '@babel/types';

  interface GeneratorOptions {
    compact?: boolean | 'auto';
    minified?: boolean;
    comments?: boolean;
    retainLines?: boolean;
    concise?: boolean;
  }

  interface GeneratorResult {
    code: string;
    map?: any;
  }

  export default function generate(ast: Node, options?: GeneratorOptions, code?: string): GeneratorResult;
}
