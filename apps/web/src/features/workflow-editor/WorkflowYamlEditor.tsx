import { useEffect, type FC } from "react";
import RawEditor, { useMonaco, type EditorProps } from "@monaco-editor/react";
import { configureMonacoYaml } from "monaco-yaml";
import { workflowJsonSchema } from "./workflowSchema.js";

/** @monaco-editor/react default export is typed as MemoExoticComponent; React 19 JSX rejects it as a component type. */
const Editor = RawEditor as unknown as FC<EditorProps>;

export interface WorkflowYamlEditorProps {
  value: string;
  onChange: (value: string | undefined) => void;
  height?: string;
}

export function WorkflowYamlEditor({ value, onChange, height = "400px" }: WorkflowYamlEditorProps) {
  const monaco = useMonaco();

  useEffect(() => {
    if (monaco) {
      configureMonacoYaml(monaco, {
        enableSchemaRequest: false,
        schemas: [
          {
            uri: "http://internal/workflow-schema.json",
            fileMatch: ["*"],
            schema: workflowJsonSchema as Record<string, unknown>,
          },
        ],
      });
    }
  }, [monaco]);

  return (
    <Editor
      height={height}
      defaultLanguage="yaml"
      theme="vs-dark"
      value={value}
      onChange={onChange}
      options={{
        minimap: { enabled: false },
        tabSize: 2,
        scrollBeyondLastLine: false,
        wordWrap: "on",
      }}
    />
  );
}
