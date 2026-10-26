import { useLayoutEffect, useRef } from "react";
import { nativePromptReadiness, useNativePromptDraft } from "../lib/nativePromptReadiness";
import { ComposerPromptEditorTiptap } from "./ComposerPromptEditorTiptap";
import type { ComposerPromptEditorProps } from "./ComposerPromptEditorTiptap";

export type {
  ComposerCitationCommentRequest,
  ComposerPromptEditorHandle,
  ComposerPromptEditorProps,
} from "./ComposerPromptEditorTiptap";

export function ComposerPromptEditor(props: ComposerPromptEditorProps) {
  const value = useRef(props.value);
  // oxlint-disable-next-line t3code/react-effect-budget -- Update the external draft reader only when controlled editor content has committed.
  useLayoutEffect(() => {
    value.current = props.value;
  });
  useNativePromptDraft(() => value.current.length > 0);
  return (
    <ComposerPromptEditorTiptap
      {...props}
      onChange={(...args) => {
        value.current = args[0];
        nativePromptReadiness.changed();
        props.onChange(...args);
      }}
    />
  );
}
