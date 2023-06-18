import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { IEditorExtensionRegistry, EditorExtensionRegistry } from '@jupyterlab/codemirror';
import { EditorView } from '@codemirror/view';
import {
  IEditorPosition,
  IRootPosition,
  offsetAtPosition,
  positionAtOffset,
  ILSPFeatureManager,
  ILSPDocumentConnectionManager
} from '@jupyterlab/lsp';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import * as lsProtocol from 'vscode-languageserver-protocol';

import { CodeSignature as LSPSignatureSettings } from '../_signature';
import { EditorTooltipManager } from '../components/free_tooltip';
import { PositionConverter } from '../converter';
import { CodeMirrorIntegration } from '../editor_integration/codemirror';
import { FeatureSettings, IFeatureLabIntegration } from '../feature';
import { ILogConsoleCore, PLUGIN_ID } from '../tokens';
import { escapeMarkdown } from '../utils';

const TOOLTIP_ID = 'signature';
const CLASS_NAME = 'lsp-signature-help';

function getMarkdown(item: string | lsProtocol.MarkupContent) {
  if (typeof item === 'string') {
    return escapeMarkdown(item);
  } else {
    if (item.kind === 'markdown') {
      return item.value;
    } else {
      return escapeMarkdown(item.value);
    }
  }
}

interface ISplit {
  lead: string;
  remainder: string;
}

export function extractLead(lines: string[], size: number): ISplit | null {
  // try to split after paragraph
  const leadLines = [];
  let splitOnParagraph = false;

  for (const line of lines.slice(0, size + 1)) {
    const isEmpty = line.trim() == '';
    if (isEmpty) {
      splitOnParagraph = true;
      break;
    }
    leadLines.push(line);
  }
  // see if we got something which does not include Markdown formatting
  // (so it won't lead to broken formatting if we split after it);
  const leadCandidate = leadLines.join('\n');

  if (splitOnParagraph && leadCandidate.search(/[\\*#[\]<>_]/g) === -1) {
    return {
      lead: leadCandidate,
      remainder: lines.slice(leadLines.length + 1).join('\n')
    };
  }
  return null;
}

/**
 * Represent signature as a Markdown element.
 */
export function signatureToMarkdown(
  item: lsProtocol.SignatureInformation,
  language: string = '',
  codeHighlighter: (
    source: string,
    variable: string,
    language: string
  ) => string,
  logger: ILogConsoleCore,
  activeParameterFallback?: number | null,
  maxLinesBeforeCollapse: number = 4
): string {
  const activeParameter: number | undefined | null =
    typeof item.activeParameter !== 'undefined'
      ? item.activeParameter
      : activeParameterFallback;
  let markdown: string;
  let label = item.label;
  if (item.parameters && activeParameter != null) {
    if (activeParameter > item.parameters.length) {
      logger.error(
        'LSP server returned wrong number for activeSignature for: ',
        item
      );
      markdown = '```' + language + '\n' + label + '\n```';
    } else {
      const parameter = item.parameters[activeParameter];
      let substring: string =
        typeof parameter.label === 'string'
          ? parameter.label
          : label.slice(parameter.label[0], parameter.label[1]);
      markdown = codeHighlighter(label, substring, language);
    }
  } else {
    markdown = '```' + language + '\n' + label + '\n```';
  }
  let details = '';
  if (item.documentation) {
    if (
      typeof item.documentation === 'string' ||
      item.documentation.kind === 'plaintext'
    ) {
      const plainTextDocumentation =
        typeof item.documentation === 'string'
          ? item.documentation
          : item.documentation.value;
      // TODO: make use of the MarkupContent object instead
      for (let line of plainTextDocumentation.split('\n')) {
        if (line.trim() === item.label.trim()) {
          continue;
        }

        details += getMarkdown(line) + '\n';
      }
    } else {
      if (item.documentation.kind !== 'markdown') {
        logger.warn('Unknown MarkupContent kind:', item.documentation.kind);
      }
      details += item.documentation.value;
    }
  } else if (item.parameters) {
    details +=
      '\n\n' +
      item.parameters
        .filter(parameter => parameter.documentation)
        .map(parameter => '- ' + getMarkdown(parameter.documentation!))
        .join('\n');
  }
  if (details) {
    const lines = details.trim().split('\n');
    if (lines.length > maxLinesBeforeCollapse) {
      const split = extractLead(lines, maxLinesBeforeCollapse);
      if (split) {
        details =
          split.lead + '\n<details>\n' + split.remainder + '\n</details>';
      } else {
        details = '<details>\n' + details + '\n</details>';
      }
    }
    markdown += '\n\n' + details;
  } else {
    markdown += '\n';
  }
  return markdown;
}

export class SignatureCM {
  protected signatureCharacter: IRootPosition;
  protected _signatureCharacters: string[];

  get settings() {
    return super.settings as FeatureSettings<LSPSignatureSettings>;
  }

  get _closeCharacters(): string[] {
    if (!this.settings) {
      return [];
    }
    return this.settings.composite.closeCharacters;
  }

  register(): void {
    this.editor_handlers.set(
      'cursorActivity',
      this.onCursorActivity.bind(this)
    );
    this.editor_handlers.set('blur', this.onBlur.bind(this));
    this.editor_handlers.set('focus', this.onCursorActivity.bind(this));
    super.register();
  }

  onBlur(virtualEditor: CodeMirrorVirtualEditor, event: FocusEvent) {
    // hide unless the focus moved to the signature itself
    // (allowing user to select/copy from signature)
    if (
      this.isSignatureShown() &&
      (event.relatedTarget as Element).closest('.' + CLASS_NAME) === null
    ) {
      this._removeTooltip();
    }
  }

  onCursorActivity() {
    if (!this.isSignatureShown()) {
      return;
    }
    const newRootPosition = this.virtual_editor.get_cursor_position();
    const initialPosition = this.lab_integration.tooltip.position;
    let newEditorPosition =
      this.virtual_editor.root_position_to_editor(newRootPosition);
    if (
      newEditorPosition.line === initialPosition.line &&
      newEditorPosition.ch < initialPosition.ch
    ) {
      // close tooltip if receded beyond starting position
      this._removeTooltip();
    } else {
      // otherwise, update the signature as the active parameter could have changed,
      // or the server may want us to close the tooltip
      this.requestSignature(newRootPosition, initialPosition)?.catch(
        this.console.warn
      );
    }
  }

  get lab_integration() {
    return super.lab_integration as SignatureLabIntegration;
  }

  protected get_markup_for_signature_help(
    response: lsProtocol.SignatureHelp,
    language: string = ''
  ): lsProtocol.MarkupContent {
    let signatures = new Array<string>();

    if (response.activeSignature != null) {
      if (response.activeSignature >= response.signatures.length) {
        this.console.error(
          'LSP server returned wrong number for activeSignature for: ',
          response
        );
      } else {
        const item = response.signatures[response.activeSignature];
        return {
          kind: 'markdown',
          value: this.signatureToMarkdown(
            item,
            language,
            response.activeParameter
          )
        };
      }
    }

    response.signatures.forEach(item => {
      let markdown = this.signatureToMarkdown(item, language);
      signatures.push(markdown);
    });

    return {
      kind: 'markdown',
      value: signatures.join('\n\n')
    };
  }

  protected highlightCode(source: string, variable: string, language: string) {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    pre.appendChild(code);
    code.className = `cm-s-jupyter language-${language}`;
    this.lab_integration.codeMirror.CodeMirror.runMode(
      source,
      language,
      (token: string, className: string) => {
        let element: HTMLElement | Node;
        if (className) {
          element = document.createElement('span');
          (element as HTMLElement).classList.add('cm-' + className);
          element.textContent = token;
        } else {
          element = document.createTextNode(token);
        }
        if (className === 'variable' && token === variable) {
          const mark = document.createElement('mark');
          mark.appendChild(element);
          element = mark;
        }
        code.appendChild(element);
      }
    );
    return pre.outerHTML;
  }

  /**
   * Represent signature as a Markdown element.
   */
  protected signatureToMarkdown(
    item: lsProtocol.SignatureInformation,
    language: string,
    activeParameterFallback?: number | null
  ): string {
    return signatureToMarkdown(
      item,
      language,
      this.highlightCode.bind(this),
      this.console,
      activeParameterFallback,
      this.settings.composite.maxLines
    );
  }

  private _removeTooltip() {
    this.lab_integration.tooltip.remove();
  }

  private _hideTooltip() {
    this.lab_integration.tooltip.hide();
  }

  private handleSignature(
    response: lsProtocol.SignatureHelp,
    position_at_request: IRootPosition,
    display_position: IEditorPosition | null = null
  ) {
    this.console.log('Signature received', response);
    if (response === null) {
      // do not hide on undefined as it simply indicates that no new info is available
      // (null means close, undefined means no update, response means update)
      this._removeTooltip();
    } else if (response) {
      this._hideTooltip();
    }

    if (!this.signatureCharacter || !response || !response.signatures.length) {
      if (response) {
        this._removeTooltip();
      }
      this.console.debug(
        'Ignoring signature response: cursor lost or response empty'
      );
      return;
    }

    let root_position = this.virtual_editor.get_cursor_position();

    // if the cursor advanced in the same line, the previously retrieved signature may still be useful
    // if the line changed or cursor moved backwards then no reason to keep the suggestions
    if (
      position_at_request.line != root_position.line ||
      root_position.ch < position_at_request.ch
    ) {
      this.console.debug(
        'Ignoring signature response: cursor has receded or changed line'
      );
      this._removeTooltip();
      return;
    }

    let cm_editor = this.get_cm_editor(root_position);
    if (!cm_editor.hasFocus()) {
      this.console.debug(
        'Ignoring signature response: the corresponding editor lost focus'
      );
      this._removeTooltip();
      return;
    }
    let editor_position =
      this.virtual_editor.root_position_to_editor(root_position);
    let language = this.get_language_at(editor_position, cm_editor);
    let markup = this.get_markup_for_signature_help(response, language);

    this.console.log(
      'Signature will be shown',
      language,
      markup,
      root_position,
      response
    );
    if (display_position === null) {
      // try to find last occurrance of trigger character to position the tooltip
      const content = cm_editor.getValue();
      const lines = content.split('\n');
      const offset = offsetAtPosition(
        PositionConverter.cm_to_ce(editor_position),
        lines
      );
      const subset = content.substring(0, offset);
      const lastTriggerCharacterOffset = Math.max(
        ...this.signatureCharacters.map(character =>
          subset.lastIndexOf(character)
        )
      );
      if (lastTriggerCharacterOffset !== -1) {
        display_position = PositionConverter.ce_to_cm(
          positionAtOffset(lastTriggerCharacterOffset, lines)
        ) as IEditorPosition;
      } else {
        display_position = editor_position;
      }
    }
    this.lab_integration.tooltip.showOrCreate({
      markup,
      position: display_position,
      id: TOOLTIP_ID,
      ceEditor: this.virtual_editor.find_ceEditor(cm_editor),
      adapter: this.adapter,
      className: CLASS_NAME,
      tooltip: {
        privilege: 'forceAbove',
        // do not move the tooltip to match the token to avoid drift of the
        // tooltip due the simplicty of token matching rules; instead we keep
        // the position constant manually via `displayPosition`.
        alignment: undefined,
        hideOnKeyPress: false
      }
    });
  }

  protected get signatureCharacters() {
    if (!this._signatureCharacters?.length) {
      this._signatureCharacters =
        this.connection.serverCapabilities?.signatureHelpProvider?.triggerCharacters || [];
    }
    return this._signatureCharacters;
  }

  protected isSignatureShown() {
    return this.lab_integration.tooltip.isShown(TOOLTIP_ID);
  }

  private _afterChange(change: IEditorChange, root_position: IRootPosition) {
    const last_character = this.extract_last_character(change);

    const isSignatureShown = this.isSignatureShown();
    let previousPosition: IEditorPosition | null = null;

    if (isSignatureShown) {
      previousPosition = this.lab_integration.tooltip.position;
      if (this._closeCharacters.includes(last_character)) {
        // remove just in case but do not short-circuit in case if we need to re-trigger
        this._removeTooltip();
      }
    }

    // only proceed if: trigger character was used or the signature is/was visible immediately before
    if (
      !(this.signatureCharacters.includes(last_character) || isSignatureShown)
    ) {
      return;
    }

    this.requestSignature(root_position, previousPosition)?.catch(
      this.console.warn
    );
  }

  private requestSignature(
    root_position: IRootPosition,
    previousPosition: IEditorPosition | null
  ) {
    if (
      !(
        this.connection.isReady &&
        this.connection.serverCapabilities?.signatureHelpProvider
      )
    ) {
      return;
    }
    this.signatureCharacter = root_position;

    let virtual_position =
      this.virtual_editor.root_position_to_virtual_position(root_position);

    return this.connection.clientRequests['textDocument/signatureHelp']
      .request({
        position: {
          line: virtual_position.line,
          character: virtual_position.ch
        },
        textDocument: {
          uri: this.virtualDocument.document_info.uri
        }
      })
      .then(help =>
        this.handleSignature(help, root_position, previousPosition)
      );
  }
}

class SignatureLabIntegration implements IFeatureLabIntegration {
  tooltip: EditorTooltipManager;
  settings: FeatureSettings<LSPSignatureSettings>;

  constructor(
    app: JupyterFrontEnd,
    settings: FeatureSettings<LSPSignatureSettings>,
    renderMimeRegistry: IRenderMimeRegistry,
  ) {
    this.tooltip = new EditorTooltipManager(renderMimeRegistry);
  }
}

const FEATURE_ID = PLUGIN_ID + ':signature';


import { Widget } from '@lumino/widgets';

// TODO things like where adapters and currentWidget come from and what is lumino should be hiddden
function findActiveAdapter(manager: Pick<ILSPDocumentConnectionManager, 'adapters'>, currentWidget: Widget | null) {
  if (currentWidget !== null) {
    return undefined;
  }
  return (
    [...manager.adapters.values()].find(adapter =>
        adapter.widget == currentWidget
    )
  );
}

function rootPositionToVirtualPosition(virtualDocument: VirtualDocument, position: IRootPosition): IVirtualPosition {
    let rootAsSource = position as ISourcePosition;
    return virtualDocument.root.virtualPositionAtDocument(
      rootAsSource
    );
  }

export const SIGNATURE_PLUGIN: JupyterFrontEndPlugin<void> = {
  id: FEATURE_ID,
  requires: [
    ILSPFeatureManager,
    ISettingRegistry,
    IRenderMimeRegistry,
    IEditorExtensionRegistry,
    ILSPDocumentConnectionManager
  ],
  autoStart: true,
  activate: (
    app: JupyterFrontEnd,
    featureManager: ILSPFeatureManager,
    settingRegistry: ISettingRegistry,
    renderMimeRegistry: IRenderMimeRegistry,
    editorExtensionRegistry: IEditorExtensionRegistry,
    connectionManager: ILSPDocumentConnectionManager
  ) => {
    const settings = new FeatureSettings<LSPSignatureSettings>(
      settingRegistry,
      FEATURE_ID
    );
    new SignatureLabIntegration(
      app,
      settings,
      renderMimeRegistry
    );

    // TODO: so we need a helper to check if current editor has an adapter

    // TODO: or use IEditor.injectExtension
    editorExtensionRegistry.addExtension({
      name: 'lsp:codeSignature',
      factory: () => {
        const selectionListener = EditorView.updateListener.of((viewUpdate) => {
           if (viewUpdate.selectionSet) {
            // get cursor position
             // get editor
             // get adapter

             // TODO use head or anochor whichever later?
             //const cursor = viewUpdate.state.selection.main.anchor;

             const adapter = findActiveAdapter(connectionManager, app.shell.currentWidget);
             if (!adapter) {
               return;
             }
             const editorAccessor = adapter.activeEditor;
             // TODO: accessor is a wrapper because CodeMirror can be detached
             // due to windowed notebook
             const editor = editorAccessor!.getEditor()!;
             const position = editor.getCursorPosition();
             // TODO: why would virtual document be missing?
             const virtualDoc = adapter.virtualDocument!;
             // TODO: why missing
             const rootPosition = virtualDoc.transformFromEditorToRoot(adapter.activeEditor!, {
               line: position.line,
               ch: position.column
             } as IEditorPosition)!;

             const virtualPosition = rootPositionToVirtualPosition(virtualDoc, rootPosition);
             // TODO send request if needed
           }
        });
        const focusListener = EditorView.domEventHandlers({
          focus: () => {
          },
          blur: () => {
          }
        })

        return EditorExtensionRegistry.createImmutableExtension([selectionListener, focusListener]);
      }
    });

    featureManager.register({
      id: FEATURE_ID,
      capabilities: {
        textDocument: {
          signatureHelp: {
            dynamicRegistration: true,
            signatureInformation: {
              documentationFormat: ['markdown', 'plaintext']
            }
          }
        }
      }
    });
  }
};
