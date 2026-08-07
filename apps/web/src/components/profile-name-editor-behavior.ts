export const PROFILE_NAME_EDITOR_MIN_WIDTH_PX = 160;

export function profileNameEditorWidth(input: {
  availableWidth: number;
  contentWidth: number;
  initialWidth: number;
}): number {
  const availableWidth = Math.max(0, input.availableWidth);
  const minimumWidth = Math.min(
    availableWidth,
    Math.max(PROFILE_NAME_EDITOR_MIN_WIDTH_PX, input.initialWidth),
  );

  return Math.min(
    availableWidth,
    Math.max(minimumWidth, input.contentWidth),
  );
}

export function shouldSubmitProfileNameEnter(input: {
  compositionActive: boolean;
  key: string;
  keyCode: number;
  nativeIsComposing: boolean;
}): boolean {
  return (
    input.key === "Enter" &&
    !input.compositionActive &&
    !input.nativeIsComposing &&
    input.keyCode !== 229
  );
}
