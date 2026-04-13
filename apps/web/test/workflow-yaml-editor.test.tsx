import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { WorkflowYamlEditor } from "../src/features/workflow-editor/WorkflowYamlEditor.js";
import { workflowJsonSchema } from "../src/features/workflow-editor/workflowSchema.js";

const configureMonacoYaml = vi.fn();

vi.mock("monaco-yaml", () => ({
  configureMonacoYaml: (...args: unknown[]) => configureMonacoYaml(...args),
}));

const useMonacoMock = vi.fn<[], unknown>();

vi.mock("@monaco-editor/react", () => ({
  __esModule: true,
  default: function MockMonacoEditor({
    height,
    value,
    onChange,
    defaultLanguage,
    theme,
    options,
  }: {
    height?: string;
    value?: string;
    onChange?: (v: string | undefined) => void;
    defaultLanguage?: string;
    theme?: string;
    options?: { tabSize?: number; wordWrap?: string; minimap?: { enabled?: boolean } };
  }) {
    return (
      <div
        data-testid="monaco-editor-mock"
        data-height={height}
        data-language={defaultLanguage}
        data-theme={theme}
        data-tab-size={options?.tabSize}
        data-word-wrap={options?.wordWrap}
        data-minimap={String(options?.minimap?.enabled)}
      >
        <textarea
          aria-label="YAML editor"
          value={value ?? ""}
          onChange={(e) => onChange?.(e.target.value)}
        />
      </div>
    );
  },
  useMonaco: () => useMonacoMock(),
}));

describe("WorkflowYamlEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not configure monaco-yaml until monaco is available", () => {
    useMonacoMock.mockReturnValue(null);
    render(<WorkflowYamlEditor value="a: 1" onChange={() => {}} />);
    expect(configureMonacoYaml).not.toHaveBeenCalled();
  });

  it("configures monaco-yaml with the workflow JSON schema when monaco is ready", () => {
    const fakeMonaco = { label: "monaco" };
    useMonacoMock.mockReturnValue(fakeMonaco);
    render(<WorkflowYamlEditor value="nodes: []" onChange={() => {}} />);
    expect(configureMonacoYaml).toHaveBeenCalledTimes(1);
    expect(configureMonacoYaml).toHaveBeenCalledWith(
      fakeMonaco,
      expect.objectContaining({
        enableSchemaRequest: false,
        schemas: [
          expect.objectContaining({
            uri: "http://internal/workflow-schema.json",
            fileMatch: ["*"],
            schema: workflowJsonSchema,
          }),
        ],
      }),
    );
  });

  it("passes value, height, and forwards onChange", () => {
    useMonacoMock.mockReturnValue({});
    const onChange = vi.fn();
    render(
      <WorkflowYamlEditor value="hello: world" onChange={onChange} height="320px" />,
    );
    const root = screen.getByTestId("monaco-editor-mock");
    expect(root).toHaveAttribute("data-height", "320px");
    expect(root).toHaveAttribute("data-language", "yaml");
    expect(root).toHaveAttribute("data-theme", "vs-dark");
    expect(root).toHaveAttribute("data-tab-size", "2");
    expect(root).toHaveAttribute("data-word-wrap", "on");
    expect(root).toHaveAttribute("data-minimap", "false");
    fireEvent.change(screen.getByRole("textbox", { name: /YAML editor/i }), {
      target: { value: "hello: world!" },
    });
    expect(onChange).toHaveBeenCalledWith("hello: world!");
  });
});
