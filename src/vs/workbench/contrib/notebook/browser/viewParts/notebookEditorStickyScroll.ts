/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from 'vs/nls';
import * as DOM from 'vs/base/browser/dom';
import { EventType as TouchEventType } from 'vs/base/browser/touch';
import { StandardMouseEvent } from 'vs/base/browser/mouseEvent';
import { Emitter, Event } from 'vs/base/common/event';
import { Disposable, DisposableStore } from 'vs/base/common/lifecycle';
import { ServicesAccessor } from 'vs/editor/browser/editorExtensions';
import { Categories } from 'vs/platform/action/common/actionCommonCategories';
import { Action2, MenuId, registerAction2 } from 'vs/platform/actions/common/actions';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { ContextKeyExpr } from 'vs/platform/contextkey/common/contextkey';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { CellFoldingState, INotebookEditor } from 'vs/workbench/contrib/notebook/browser/notebookBrowser';
import { INotebookCellList } from 'vs/workbench/contrib/notebook/browser/view/notebookRenderingCommon';
import { OutlineEntry } from 'vs/workbench/contrib/notebook/browser/viewModel/OutlineEntry';
import { NotebookCellOutlineProvider } from 'vs/workbench/contrib/notebook/browser/viewModel/notebookOutlineProvider';
import { CellKind } from 'vs/workbench/contrib/notebook/common/notebookCommon';
import { Delayer } from 'vs/base/common/async';
import { ThemeIcon } from 'vs/base/common/themables';
import { foldingCollapsedIcon, foldingExpandedIcon } from 'vs/editor/contrib/folding/browser/foldingDecorations';
import { MarkupCellViewModel } from 'vs/workbench/contrib/notebook/browser/viewModel/markupCellViewModel';
import { FoldingController } from 'vs/workbench/contrib/notebook/browser/controller/foldingController';
import { NotebookOptionsChangeEvent } from 'vs/workbench/contrib/notebook/browser/notebookOptions';

export class ToggleNotebookStickyScroll extends Action2 {

	constructor() {
		super({
			id: 'notebook.action.toggleNotebookStickyScroll',
			title: {
				...localize2('toggleStickyScroll', "Toggle Notebook Sticky Scroll"),
				mnemonicTitle: localize({ key: 'mitoggleNotebookStickyScroll', comment: ['&& denotes a mnemonic'] }, "&&Toggle Notebook Sticky Scroll"),
			},
			category: Categories.View,
			toggled: {
				condition: ContextKeyExpr.equals('config.notebook.stickyScroll.enabled', true),
				title: localize('notebookStickyScroll', "Notebook Sticky Scroll"),
				mnemonicTitle: localize({ key: 'mitoggleNotebookStickyScroll', comment: ['&& denotes a mnemonic'] }, "&&Toggle Notebook Sticky Scroll"),
			},
			menu: [
				{ id: MenuId.CommandPalette },
				{
					id: MenuId.NotebookStickyScrollContext,
					group: 'notebookView',
					order: 2
				}
			]
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		const newValue = !configurationService.getValue('notebook.stickyScroll.enabled');
		return configurationService.updateValue('notebook.stickyScroll.enabled', newValue);
	}
}

type RunInSectionContext = {
	target: HTMLElement;
	currentStickyLines: Map<OutlineEntry, { line: NotebookStickyLine; rendered: boolean }>;
	notebookEditor: INotebookEditor;
};

export class RunInSectionStickyScroll extends Action2 {
	constructor() {
		super({
			id: 'notebook.action.runInSection',
			title: {
				...localize2('runInSectionStickyScroll', "Run Section"),
				mnemonicTitle: localize({ key: 'mirunInSectionStickyScroll', comment: ['&& denotes a mnemonic'] }, "&&Run Section"),
			},
			menu: [
				{
					id: MenuId.NotebookStickyScrollContext,
					group: 'notebookExecution',
					order: 1
				}
			]
		});
	}

	override async run(accessor: ServicesAccessor, context: RunInSectionContext, ...args: any[]): Promise<void> {
		const selectedElement = context.target.parentElement;
		const stickyLines: Map<OutlineEntry, {
			line: NotebookStickyLine;
			rendered: boolean;
		}> = context.currentStickyLines;

		const selectedOutlineEntry = Array.from(stickyLines.values()).find(entry => entry.line.element.contains(selectedElement))?.line.entry;
		if (!selectedOutlineEntry) {
			return;
		}

		const flatList: OutlineEntry[] = [];
		selectedOutlineEntry.asFlatList(flatList);

		const cellViewModels = flatList.map(entry => entry.cell);
		const notebookEditor: INotebookEditor = context.notebookEditor;
		notebookEditor.executeNotebookCells(cellViewModels);
	}
}

export class NotebookStickyLine extends Disposable {
	constructor(
		public readonly element: HTMLElement,
		public readonly foldingIcon: StickyFoldingIcon,
		public readonly header: HTMLElement,
		public readonly entry: OutlineEntry,
		public readonly notebookEditor: INotebookEditor,
	) {
		super();
		// click the header to focus the cell
		this._register(DOM.addDisposableListener(this.header, DOM.EventType.CLICK || TouchEventType.Tap, () => {
			this.focusCell();
		}));

		// click the folding icon to fold the range covered by the header
		this._register(DOM.addDisposableListener(this.foldingIcon.domNode, DOM.EventType.CLICK || TouchEventType.Tap, () => {
			if (this.entry.cell.cellKind === CellKind.Markup) {
				const currentFoldingState = (this.entry.cell as MarkupCellViewModel).foldingState;
				this.toggleFoldRange(currentFoldingState);
			}
		}));

	}

	private toggleFoldRange(currentState: CellFoldingState) {
		const foldingController = this.notebookEditor.getContribution<FoldingController>(FoldingController.id);

		const index = this.entry.index;
		const headerLevel = this.entry.level;
		const newFoldingState = (currentState === CellFoldingState.Collapsed) ? CellFoldingState.Expanded : CellFoldingState.Collapsed;

		foldingController.setFoldingStateUp(index, newFoldingState, headerLevel);
		this.focusCell();
	}

	private focusCell() {
		this.notebookEditor.focusNotebookCell(this.entry.cell, 'container');
		const cellScrollTop = this.notebookEditor.getAbsoluteTopOfElement(this.entry.cell);
		const parentCount = NotebookStickyLine.getParentCount(this.entry);
		// 1.1 addresses visible cell padding, to make sure we don't focus md cell and also render its sticky line
		this.notebookEditor.setScrollTop(cellScrollTop - (parentCount + 1.1) * 22);
	}

	static getParentCount(entry: OutlineEntry) {
		let count = 0;
		while (entry.parent) {
			count++;
			entry = entry.parent;
		}
		return count;
	}
}

class StickyFoldingIcon {

	public domNode: HTMLElement;

	constructor(
		public isCollapsed: boolean,
		public dimension: number
	) {
		this.domNode = document.createElement('div');
		this.domNode.style.width = `${dimension}px`;
		this.domNode.style.height = `${dimension}px`;
		this.domNode.className = ThemeIcon.asClassName(isCollapsed ? foldingCollapsedIcon : foldingExpandedIcon);
	}

	public setVisible(visible: boolean) {
		this.domNode.style.cursor = visible ? 'pointer' : 'default';
		this.domNode.style.opacity = visible ? '1' : '0';
	}
}

export class NotebookStickyScroll extends Disposable {
	private readonly _disposables = new DisposableStore();
	private currentStickyLines = new Map<OutlineEntry, { line: NotebookStickyLine; rendered: boolean }>();
	private filteredOutlineEntries: OutlineEntry[] = [];

	private readonly _onDidChangeNotebookStickyScroll = this._register(new Emitter<number>());
	readonly onDidChangeNotebookStickyScroll: Event<number> = this._onDidChangeNotebookStickyScroll.event;

	getDomNode(): HTMLElement {
		return this.domNode;
	}

	getCurrentStickyHeight() {
		let height = 0;
		this.currentStickyLines.forEach((value) => {
			if (value.rendered) {
				height += 22;
			}
		});
		return height;
	}

	private setCurrentStickyLines(newStickyLines: Map<OutlineEntry, { line: NotebookStickyLine; rendered: boolean }>) {
		this.currentStickyLines = newStickyLines;
	}

	private compareStickyLineMaps(mapA: Map<OutlineEntry, { line: NotebookStickyLine; rendered: boolean }>, mapB: Map<OutlineEntry, { line: NotebookStickyLine; rendered: boolean }>): boolean {
		if (mapA.size !== mapB.size) {
			return false;
		}

		for (const [key, value] of mapA) {
			const otherValue = mapB.get(key);
			if (!otherValue || value.rendered !== otherValue.rendered) {
				return false;
			}
		}

		return true;
	}

	constructor(
		private readonly domNode: HTMLElement,
		private readonly notebookEditor: INotebookEditor,
		private readonly notebookOutline: NotebookCellOutlineProvider,
		private readonly notebookCellList: INotebookCellList,
		@IContextMenuService private readonly _contextMenuService: IContextMenuService,
	) {
		super();

		if (this.notebookEditor.notebookOptions.getDisplayOptions().stickyScrollEnabled) {
			this.init();
		}

		this._register(this.notebookEditor.notebookOptions.onDidChangeOptions((e) => {
			if (e.stickyScrollEnabled || e.stickyScrollMode) {
				this.updateConfig(e);
			}
		}));

		this._register(DOM.addDisposableListener(this.domNode, DOM.EventType.CONTEXT_MENU, async (event: MouseEvent) => {
			this.onContextMenu(event);
		}));
	}

	private onContextMenu(e: MouseEvent) {
		const event = new StandardMouseEvent(DOM.getWindow(this.domNode), e);

		const context: RunInSectionContext = {
			target: event.target,
			currentStickyLines: this.currentStickyLines,
			notebookEditor: this.notebookEditor,
		};

		this._contextMenuService.showContextMenu({
			menuId: MenuId.NotebookStickyScrollContext,
			getAnchor: () => event,
			menuActionOptions: { shouldForwardArgs: true, arg: context },
		});
	}

	private updateConfig(e: NotebookOptionsChangeEvent) {
		if (e.stickyScrollEnabled) {
			if (this.notebookEditor.notebookOptions.getDisplayOptions().stickyScrollEnabled) {
				this.init();
			} else {
				this._disposables.clear();
				this.notebookOutline.dispose();
				this.disposeCurrentStickyLines();
				DOM.clearNode(this.domNode);
				this.updateDisplay();
			}
		} else if (e.stickyScrollMode && this.notebookEditor.notebookOptions.getDisplayOptions().stickyScrollEnabled) {
			this.updateContent(computeContent(this.notebookEditor, this.notebookCellList, this.filteredOutlineEntries, this.getCurrentStickyHeight()));
		}
	}

	private init() {
		this.notebookOutline.init();
		this.filteredOutlineEntries = this.notebookOutline.entries.filter(entry => entry.level !== 7);
		this.updateContent(computeContent(this.notebookEditor, this.notebookCellList, this.filteredOutlineEntries, this.getCurrentStickyHeight()));

		this._disposables.add(this.notebookOutline.onDidChange(() => {
			this.filteredOutlineEntries = this.notebookOutline.entries.filter(entry => entry.level !== 7);
			const recompute = computeContent(this.notebookEditor, this.notebookCellList, this.filteredOutlineEntries, this.getCurrentStickyHeight());
			if (!this.compareStickyLineMaps(recompute, this.currentStickyLines)) {
				this.updateContent(recompute);
			}
		}));

		this._disposables.add(this.notebookEditor.onDidAttachViewModel(() => {
			this.notebookOutline.init();
			this.updateContent(computeContent(this.notebookEditor, this.notebookCellList, this.filteredOutlineEntries, this.getCurrentStickyHeight()));
		}));

		this._disposables.add(this.notebookEditor.onDidScroll(() => {
			const d = new Delayer(100);
			d.trigger(() => {
				d.dispose();
				const recompute = computeContent(this.notebookEditor, this.notebookCellList, this.filteredOutlineEntries, this.getCurrentStickyHeight());
				if (!this.compareStickyLineMaps(recompute, this.currentStickyLines)) {
					this.updateContent(recompute);
				}
			});
		}));
	}

	// take in an cell index, and get the corresponding outline entry
	static getVisibleOutlineEntry(visibleIndex: number, notebookOutlineEntries: OutlineEntry[]): OutlineEntry | undefined {
		let left = 0;
		let right = notebookOutlineEntries.length - 1;
		let bucket = -1;

		while (left <= right) {
			const mid = Math.floor((left + right) / 2);
			if (notebookOutlineEntries[mid].index === visibleIndex) {
				bucket = mid;
				break;
			} else if (notebookOutlineEntries[mid].index < visibleIndex) {
				bucket = mid;
				left = mid + 1;
			} else {
				right = mid - 1;
			}
		}

		if (bucket !== -1) {
			const rootEntry = notebookOutlineEntries[bucket];
			const flatList: OutlineEntry[] = [];
			rootEntry.asFlatList(flatList);
			return flatList.find(entry => entry.index === visibleIndex);
		}
		return undefined;
	}

	private updateContent(newMap: Map<OutlineEntry, { line: NotebookStickyLine; rendered: boolean }>) {
		DOM.clearNode(this.domNode);
		this.disposeCurrentStickyLines();
		this.renderStickyLines(newMap, this.domNode);

		const oldStickyHeight = this.getCurrentStickyHeight();
		this.setCurrentStickyLines(newMap);

		// (+) = sticky height increased
		// (-) = sticky height decreased
		const sizeDelta = this.getCurrentStickyHeight() - oldStickyHeight;
		if (sizeDelta !== 0) {
			this._onDidChangeNotebookStickyScroll.fire(sizeDelta);
		}
		this.updateDisplay();
	}

	private updateDisplay() {
		const hasSticky = this.getCurrentStickyHeight() > 0;
		if (!hasSticky) {
			this.domNode.style.display = 'none';
		} else {
			this.domNode.style.display = 'block';
		}
	}

	static computeStickyHeight(entry: OutlineEntry) {
		let height = 0;
		if (entry.cell.cellKind === CellKind.Markup && entry.level !== 7) {
			height += 22;
		}
		while (entry.parent) {
			height += 22;
			entry = entry.parent;
		}
		return height;
	}

	static checkCollapsedStickyLines(entry: OutlineEntry | undefined, numLinesToRender: number, notebookEditor: INotebookEditor) {
		let currentEntry = entry;
		const newMap = new Map<OutlineEntry, { line: NotebookStickyLine; rendered: boolean }>();

		const elementsToRender = [];
		while (currentEntry) {
			if (currentEntry.level === 7) {
				// level 7 represents a non-header entry, which we don't want to render
				currentEntry = currentEntry.parent;
				continue;
			}
			const lineToRender = NotebookStickyScroll.createStickyElement(currentEntry, notebookEditor);
			newMap.set(currentEntry, { line: lineToRender, rendered: false });
			elementsToRender.unshift(lineToRender);
			currentEntry = currentEntry.parent;
		}

		// iterate over elements to render, and append to container
		// break when we reach numLinesToRender
		for (let i = 0; i < elementsToRender.length; i++) {
			if (i >= numLinesToRender) {
				break;
			}
			newMap.set(elementsToRender[i].entry, { line: elementsToRender[i], rendered: true });
		}
		return newMap;
	}

	private renderStickyLines(stickyMap: Map<OutlineEntry, { line: NotebookStickyLine; rendered: boolean }>, containerElement: HTMLElement) {
		const reversedEntries = Array.from(stickyMap.entries()).reverse();
		for (const [, value] of reversedEntries) {
			if (!value.rendered) {
				continue;
			}
			containerElement.append(value.line.element);
		}
	}

	static createStickyElement(entry: OutlineEntry, notebookEditor: INotebookEditor) {
		const stickyElement = document.createElement('div');
		stickyElement.classList.add('notebook-sticky-scroll-element');

		const indentMode = notebookEditor.notebookOptions.getLayoutConfiguration().stickyScrollMode;
		if (indentMode === 'indented') {
			stickyElement.style.paddingLeft = NotebookStickyLine.getParentCount(entry) * 10 + 'px';
		}

		let isCollapsed = false;
		if (entry.cell.cellKind === CellKind.Markup) {
			isCollapsed = (entry.cell as MarkupCellViewModel).foldingState === CellFoldingState.Collapsed;
		}

		const stickyFoldingIcon = new StickyFoldingIcon(isCollapsed, 16);
		stickyFoldingIcon.domNode.classList.add('notebook-sticky-scroll-folding-icon');
		stickyFoldingIcon.setVisible(true);

		const stickyHeader = document.createElement('div');
		stickyHeader.classList.add('notebook-sticky-scroll-header');
		stickyHeader.innerText = entry.label;

		stickyElement.append(stickyFoldingIcon.domNode, stickyHeader);

		return new NotebookStickyLine(stickyElement, stickyFoldingIcon, stickyHeader, entry, notebookEditor);
	}

	private disposeCurrentStickyLines() {
		this.currentStickyLines.forEach((value) => {
			value.line.dispose();
		});
	}

	override dispose() {
		this._disposables.dispose();
		this.disposeCurrentStickyLines();
		this.notebookOutline.dispose();
		super.dispose();
	}
}

export function computeContent(notebookEditor: INotebookEditor, notebookCellList: INotebookCellList, notebookOutlineEntries: OutlineEntry[], renderedStickyHeight: number): Map<OutlineEntry, { line: NotebookStickyLine; rendered: boolean }> {
	// get data about the cell list within viewport ----------------------------------------------------------------------------------------
	const editorScrollTop = notebookEditor.scrollTop - renderedStickyHeight;
	const visibleRange = notebookEditor.visibleRanges[0];
	if (!visibleRange) {
		return new Map();
	}

	// edge case for cell 0 in the notebook is a header ------------------------------------------------------------------------------------
	if (visibleRange.start === 0) {
		const firstCell = notebookEditor.cellAt(0);
		const firstCellEntry = NotebookStickyScroll.getVisibleOutlineEntry(0, notebookOutlineEntries);
		if (firstCell && firstCellEntry && firstCell.cellKind === CellKind.Markup && firstCellEntry.level !== 7) {
			if (notebookEditor.scrollTop > 22) {
				const newMap = NotebookStickyScroll.checkCollapsedStickyLines(firstCellEntry, 100, notebookEditor);
				return newMap;
			}
		}
	}

	// iterate over cells in viewport ------------------------------------------------------------------------------------------------------
	let cell;
	let cellEntry;
	const startIndex = visibleRange.start - 1; // -1 to account for cells hidden "under" sticky lines.
	for (let currentIndex = startIndex; currentIndex < visibleRange.end; currentIndex++) {
		// store data for current cell, and next cell
		cell = notebookEditor.cellAt(currentIndex);
		if (!cell) {
			return new Map();
		}
		cellEntry = NotebookStickyScroll.getVisibleOutlineEntry(currentIndex, notebookOutlineEntries);
		if (!cellEntry) {
			return new Map();
		}

		const nextCell = notebookEditor.cellAt(currentIndex + 1);
		if (!nextCell) {
			const sectionBottom = notebookEditor.getLayoutInfo().scrollHeight;
			const linesToRender = Math.floor((sectionBottom) / 22);
			const newMap = NotebookStickyScroll.checkCollapsedStickyLines(cellEntry, linesToRender, notebookEditor);
			return newMap;
		}
		const nextCellEntry = NotebookStickyScroll.getVisibleOutlineEntry(currentIndex + 1, notebookOutlineEntries);
		if (!nextCellEntry) {
			return new Map();
		}

		// check next cell, if markdown with non level 7 entry, that means this is the end of the section (new header) ---------------------
		if (nextCell.cellKind === CellKind.Markup && nextCellEntry.level !== 7) {
			const sectionBottom = notebookCellList.getCellViewScrollTop(nextCell);
			const currentSectionStickyHeight = NotebookStickyScroll.computeStickyHeight(cellEntry);
			const nextSectionStickyHeight = NotebookStickyScroll.computeStickyHeight(nextCellEntry);

			// case: we can render the all sticky lines for the current section ------------------------------------------------------------
			if (editorScrollTop + currentSectionStickyHeight < sectionBottom) {
				const linesToRender = Math.floor((sectionBottom - editorScrollTop) / 22);
				const newMap = NotebookStickyScroll.checkCollapsedStickyLines(cellEntry, linesToRender, notebookEditor);
				return newMap;
			}

			// case: next section is the same size or bigger, render next entry -----------------------------------------------------------
			else if (nextSectionStickyHeight >= currentSectionStickyHeight) {
				const newMap = NotebookStickyScroll.checkCollapsedStickyLines(nextCellEntry, 100, notebookEditor);
				return newMap;
			}
			// case: next section is the smaller, shrink until next section height is greater than the available space ---------------------
			else if (nextSectionStickyHeight < currentSectionStickyHeight) {
				const availableSpace = sectionBottom - editorScrollTop;

				if (availableSpace >= nextSectionStickyHeight) {
					const linesToRender = Math.floor((availableSpace) / 22);
					const newMap = NotebookStickyScroll.checkCollapsedStickyLines(cellEntry, linesToRender, notebookEditor);
					return newMap;
				} else {
					const newMap = NotebookStickyScroll.checkCollapsedStickyLines(nextCellEntry, 100, notebookEditor);
					return newMap;
				}
			}
		}
	} // visible range loop close

	// case: all visible cells were non-header cells, so render any headers relevant to their section --------------------------------------
	const sectionBottom = notebookEditor.getLayoutInfo().scrollHeight;
	const linesToRender = Math.floor((sectionBottom - editorScrollTop) / 22);
	const newMap = NotebookStickyScroll.checkCollapsedStickyLines(cellEntry, linesToRender, notebookEditor);
	return newMap;
}

registerAction2(ToggleNotebookStickyScroll);
registerAction2(RunInSectionStickyScroll);
