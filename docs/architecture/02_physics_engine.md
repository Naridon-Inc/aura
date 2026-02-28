# The Physics Engine: AST & Immutable Logic

## Tree-Sitter Integration
Aura embeds the `tree-sitter` C-library (via Rust bindings) to parse code the way a compiler does. Currently supporting Python, Rust, and JavaScript/TypeScript, Aura breaks files down into structural components (`function_definition`, `class_definition`).

## Immutable Logic Identity (The `node_id`)
The greatest flaw in standard Git is the "Renaming Death Spiral." If an AI renames a function and moves it to another file, Git records a deletion and an insertion, severing the history forever.

Aura solves this through **Structural Skeleton Hashing**. 
1. When parsing a node, Aura strips out whitespace and variable names, creating a hash of the raw structural logic.
2. If a developer renames a function, Aura's two-stage confidence engine detects the >95% structural match and forcefully inherits the old `node_id`. 
3. The logic block maintains a continuous historical thread, regardless of what it is called or where it lives.

## The Epistemic Truth Model
Aura explicitly surfaces uncertainty to maintain developer trust. 
When Aura links a refactored node to its ancestor, it assigns a `confidence` score (e.g., 0.85). In the React dashboard, this is displayed clearly so senior engineers know exactly how much of the original logic survived the refactor. 
Aura never claims absolute certainty when heuristics are involved.
