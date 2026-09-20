import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';

function languageForFile(file: string): string {
  if (file.endsWith('.json')) return 'json';
  if (file.endsWith('.js')) return 'javascript';
  return 'text';
}

export interface DiffViewProps {
  file: string;
  oldContent: string;
  newContent: string;
}

/**
 * Old vs new content for the file the Investigator patched. Dark theme
 * hand-tuned to the app's own tokens (src/index.css) rather than the
 * library's built-in dark theme, so it reads as part of the same UI.
 */
export function DiffView({ file, oldContent, newContent }: DiffViewProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-border [&_pre]:font-mono">
      <ReactDiffViewer
        oldValue={oldContent}
        newValue={newContent}
        splitView={false}
        compareMethod={DiffMethod.WORDS}
        useDarkTheme
        highlightLanguage={languageForFile(file)}
        leftTitle="Before"
        rightTitle="After"
        styles={{
          diffContainer: { fontFamily: 'var(--font-mono)', fontSize: '12.5px' },
          variables: {
            dark: {
              diffViewerBackground: 'var(--card)',
              diffViewerColor: 'var(--foreground)',
              diffViewerTitleBackground: 'var(--muted)',
              diffViewerTitleColor: 'var(--foreground)',
              diffViewerTitleBorderColor: 'var(--border)',
              addedBackground: 'rgba(34,197,94,0.12)',
              addedColor: '#86efac',
              removedBackground: 'rgba(239,68,68,0.12)',
              removedColor: '#fca5a5',
              wordAddedBackground: 'rgba(34,197,94,0.35)',
              wordRemovedBackground: 'rgba(239,68,68,0.35)',
              addedGutterBackground: 'rgba(34,197,94,0.08)',
              removedGutterBackground: 'rgba(239,68,68,0.08)',
              gutterBackground: 'var(--card)',
              gutterBackgroundDark: 'var(--muted)',
              gutterColor: 'var(--muted-foreground)',
              codeFoldGutterBackground: 'var(--muted)',
              codeFoldBackground: 'var(--muted)',
              codeFoldContentColor: 'var(--muted-foreground)',
              emptyLineBackground: 'var(--card)',
              highlightBackground: 'rgba(34,211,238,0.08)',
              highlightGutterBackground: 'rgba(34,211,238,0.12)',
            },
          },
        }}
      />
    </div>
  );
}
