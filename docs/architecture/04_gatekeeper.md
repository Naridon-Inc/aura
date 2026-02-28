# The Enterprise Gatekeeper

## Deep AST Traversal
Aura protects the broader codebase from individual AI mistakes using the Gatekeeper (`aura verify-env`). 
Unlike primitive linters that rely on string matching (which falsely flag comments like `# do not use sqlite`), Aura executes a **Deep AST Traversal**. It recursively walks the `tree-sitter` tree, specifically targeting `call_expression` and `import_statement` nodes. It mathematically proves whether forbidden logic exists in the executable path.

## The Merkle-Graph (Blast Radius)
Functions do not exist in isolation. Aura maps every function call to its target, building a Directed Graph of the repository using `petgraph`. 
If an AI agent accidentally modifies a core security function (like `hash_password`), the Gatekeeper calculates the "Blast Radius"—warning the developer of every downstream API route that is now potentially compromised.

## The "Warn-By-Default" Doctrine
To prevent developers from encountering "uninstall moments" during 2 AM hotfixes, the Gatekeeper defaults to a **Warning Policy**. It prints a highly descriptive, actionable stack trace explaining *why* the AI code violates policy, but it allows the human to proceed. Hard-blocks are strictly reserved for cryptographic secret leaks or explicit override flags.
