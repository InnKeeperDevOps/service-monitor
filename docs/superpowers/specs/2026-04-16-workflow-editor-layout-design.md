# Workflow Editor IDE Layout

## Overview
The Workflow Editor page layout is being redesigned to maximize canvas space and organize tools by context, moving from a crowded top-toolbar design to a modern IDE-style layout (Header + Left Sidebar + Contextual Right Panel).

## Architecture

### Top Header (Context & Primary Actions)
- **Position:** Full width, slim profile, immediately above the main workspace.
- **Left Side:** Context setters:
  - `Service` dropdown
  - `Saved Workflow` dropdown
  - `Name` input field
- **Right Side:** Primary "happy path" actions:
  - `Set Active` (secondary button)
  - `Save Workflow` (primary button)
  - `Queue on Agent` (danger/run button)
- **Status Area:** Success/Error/Info messages render directly below the header, pushing content down slightly rather than floating over it.

### Left Sidebar (Tools & Palette)
- **Position:** Persistent sidebar on the left side of the workspace (~220px wide).
- **Top Section (Secondary Actions):**
  - Grouped buttons stacked vertically or in a 2-column grid:
    - Validate / Dry run
    - Load selected
    - Refresh list
    - Switch to YAML / Switch to Visual
    - Auto-fill Test Workflow
- **Bottom Section (Palette):**
  - The node palette (Events, Control, Actions) and its search filter are permanently housed here. Users drag nodes directly from the left sidebar onto the canvas.

### Center Workspace (Canvas or YAML)
- **Visual Mode:** The React Flow canvas occupies all available space between the left sidebar and the right edge (or the contextual right panel, if open).
- **YAML Mode:** The Monaco YAML editor occupies this same central space.

### Right Panel (Contextual Configuration)
- **Position:** Right side of the workspace (~280-300px wide).
- **Visibility:** Highly contextual. It **only** appears when a Node or Edge is selected.
- **Behavior:** Clicking the empty canvas (`onPaneClick` handler) closes the right panel entirely, instantly returning horizontal space to the canvas.
- **Content:** Unchanged from current implementation (`NodeConfigPanel` or `EdgeConfigPanel` depending on selection).

## Data Flow & State
- Layout changes require structural refactoring of the `WorkflowEditorPage` component's JSX tree.
- State variables for `editorMode`, `nodes`, `edges`, etc. remain unchanged.
- The `PalettePanel` component moves from the right aside into the new left aside.
- Secondary actions move out of the top flex container into the left aside.
- The right `<aside>` conditionally renders based on `selectedNode || selectedEdge`.

## Testing
- Ensure drag-and-drop from the new left palette calculates correct canvas positions (React Flow coordinates may shift due to the new layout grid).
- Verify the right panel opens and closes cleanly without disrupting the graph viewport unpleasantly.
- Verify the YAML editor renders correctly when toggled and occupies the correct remaining space.