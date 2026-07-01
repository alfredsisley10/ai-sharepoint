import * as vscode from "vscode";
import { MemoryItem, MemoryScope } from "../context/memory";
import { MemoryStore } from "../context/memoryStore";

/**
 * Shared rendering for the "Memory" group that hangs off a site/source node in
 * the Sites and Reference Sources trees, so both views nest memory identically.
 * A single collapsible "Memory (N)" folder appears under an entity when it has
 * notes; expanding it lists the notes (user + AI-proposed). Management is via the
 * "Manage Memory…" command (context menu / palette).
 */

/** Synthetic folder node: the "Memory" group for one entity. */
export interface MemoryGroupNode {
  memoryScope: MemoryScope;
}

export function isMemoryGroup(n: unknown): n is MemoryGroupNode {
  return !!n && typeof n === "object" && "memoryScope" in n;
}

export function isMemoryItem(n: unknown): n is MemoryItem {
  return !!n && typeof n === "object" && "scope" in n && "origin" in n && "text" in n && "title" in n;
}

/** Children to append under an entity node: the Memory group, only when it has
 *  notes (keeps the tree clean for entities with none). */
export function memoryGroupChildren(memory: MemoryStore, scope: MemoryScope): MemoryGroupNode[] {
  return memory.listForScope(scope).length > 0 ? [{ memoryScope: scope }] : [];
}

/** Whether an entity has any memory (drives making its node collapsible). */
export function hasMemory(memory: MemoryStore, scope: MemoryScope): boolean {
  return memory.listForScope(scope).length > 0;
}

export function memoryGroupTreeItem(node: MemoryGroupNode, memory: MemoryStore): vscode.TreeItem {
  const count = memory.listForScope(node.memoryScope).length;
  const item = new vscode.TreeItem(`Memory (${count})`, vscode.TreeItemCollapsibleState.Collapsed);
  item.iconPath = new vscode.ThemeIcon("note");
  item.contextValue = "memory-group";
  item.tooltip = "Notes that give the assistant extra context about this site/source. Use “Manage Memory…” to add/edit.";
  return item;
}

export function memoryItemTreeItem(item: MemoryItem): vscode.TreeItem {
  const t = new vscode.TreeItem(item.title, vscode.TreeItemCollapsibleState.None);
  t.id = `mem:${item.id}`;
  t.description = item.origin === "ai" ? "AI-proposed" : undefined;
  t.iconPath = new vscode.ThemeIcon(item.origin === "ai" ? "sparkle" : "note");
  t.contextValue = "memory-item";
  const tags = item.tags?.length ? `\n\n_${item.tags.join(", ")}_` : "";
  t.tooltip = new vscode.MarkdownString(`**${item.title}**${item.origin === "ai" ? " · AI-proposed" : ""}\n\n${item.text.replace(/\n/g, "  \n")}${tags}`);
  return t;
}
