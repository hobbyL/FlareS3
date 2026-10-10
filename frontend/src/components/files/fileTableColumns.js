import { h } from 'vue'
import { FolderInput, Info, Pencil, RotateCcw, Share2, Trash, Trash2 } from 'lucide-vue-next'
import Button from '../ui/button/Button.vue'
import Tag from '../ui/tag/Tag.vue'
import TableCellText from '../ui/table/TableCellText.vue'
import {
  canManageFileShare,
  formatFileBytes,
  formatFileDateTime,
  getFileDisplayStatus,
  getFileExpiresText,
  getFileRemainingText,
  isFileDeleted,
} from '../../utils/files.js'

export function buildFilesTableColumns({
  t,
  locale = 'zh-CN',
  uiTheme = '',
  isTrashMode = false,
  isAdmin = false,
  loading = false,
  deleting = false,
  selectionEnabled = false,
  pageRowIds = [],
  allRowsSelected = false,
  selectAllIndeterminate = false,
  selectedIdSet = new Set(),
  onToggleSelectAll = () => {},
  onToggleRowSelection = () => {},
  onShowFileInfo = () => {},
  onShowFileShare = () => {},
  onDeleteFile = () => {},
  onRestoreFile = () => {},
  onDeletePermanent = () => {},
  onRenameFile = () => {},
  onMoveFile = () => {},
} = {}) {
  const translate = typeof t === 'function' ? t : (key) => key
  const selectedKeys = selectedIdSet instanceof Set ? selectedIdSet : new Set()

  const columns = [
    {
      title: translate('files.columns.filename'),
      key: 'filename',
      align: 'left',
      ellipsis: true,
      render: (row) => h(TableCellText, { value: row.filename }),
    },
    {
      title: translate('files.columns.size'),
      key: 'size',
      width: 100,
      align: 'center',
      ellipsis: true,
      render: (row) => h(TableCellText, { value: formatFileBytes(row.size) }),
    },
    {
      title: translate('files.columns.expires'),
      key: 'expires_in',
      width: 100,
      align: 'center',
      ellipsis: true,
      render: (row) => h(TableCellText, { value: getFileExpiresText(row, translate) }),
    },
    {
      title: translate('files.columns.status'),
      key: 'status',
      width: 80,
      align: 'center',
      ellipsis: false,
      render: (row) => {
        const { text, tagType } = getFileDisplayStatus(row, translate)
        return h(
          Tag,
          {
            type: tagType,
            size: 'small',
          },
          () => text
        )
      },
    },
    {
      title: translate('files.columns.remaining'),
      key: 'remaining_time',
      width: 160,
      align: 'center',
      ellipsis: true,
      render: (row) =>
        h(TableCellText, {
          value: getFileRemainingText(row, { isTrashMode }),
        }),
    },
    {
      title: isTrashMode
        ? translate('files.columns.deletedAt')
        : translate('files.columns.uploadedAt'),
      key: isTrashMode ? 'deleted_at' : 'created_at',
      width: 160,
      align: 'center',
      ellipsis: true,
      render: (row) =>
        h(TableCellText, {
          value: formatFileDateTime(isTrashMode ? row.deleted_at : row.created_at, locale),
        }),
    },
    ...(isAdmin
      ? [
          {
            title: translate('files.columns.owner'),
            key: 'owner',
            width: 120,
            align: 'center',
            ellipsis: true,
            render: (row) => h(TableCellText, { value: row.owner_username || row.owner_id }),
          },
        ]
      : []),
    {
      title: translate('files.columns.actions'),
      key: 'actions',
      width:
        locale === 'zh-CN' ? (uiTheme === 'shadcn' ? 380 : 440) : uiTheme === 'shadcn' ? 440 : 510,
      align: 'center',
      ellipsis: false,
      fixed: 'right',
      render: (row) => {
        const disabled = loading || deleting
        if (isTrashMode) {
          return h('div', { class: 'action-buttons' }, [
            h(
              Button,
              {
                size: 'small',
                type: 'default',
                disabled,
                onClick: () => onRestoreFile(row.id),
              },
              () => [
                h(RotateCcw, { size: 16, style: 'margin-right: 4px' }),
                translate('files.actions.restore'),
              ]
            ),
            h(
              Button,
              {
                size: 'small',
                type: 'danger',
                disabled,
                onClick: () => onDeletePermanent(row.id),
              },
              () => [
                h(Trash, { size: 16, style: 'margin-right: 4px' }),
                translate('files.actions.deletePermanent'),
              ]
            ),
          ])
        }

        const rowDisabled = disabled || isFileDeleted(row)
        const shareDisabled = disabled || !canManageFileShare(row)
        // 仅完成上传的文件可重命名（pending/uploading 等未落远端，改名无对象可 move）
        const renameDisabled = rowDisabled || row.upload_status !== 'completed'
        return h('div', { class: 'action-buttons' }, [
          h(
            Button,
            {
              size: 'small',
              type: 'default',
              disabled: rowDisabled,
              onClick: () => onShowFileInfo(row),
            },
            () => [h(Info, { size: 16, style: 'margin-right: 4px' }), translate('common.details')]
          ),
          h(
            Button,
            {
              size: 'small',
              type: 'default',
              disabled: renameDisabled,
              onClick: () => onRenameFile(row),
            },
            () => [
              h(Pencil, { size: 16, style: 'margin-right: 4px' }),
              translate('files.rename.action'),
            ]
          ),
          h(
            Button,
            {
              size: 'small',
              type: 'default',
              disabled: renameDisabled,
              onClick: () => onMoveFile(row),
            },
            () => [
              h(FolderInput, { size: 16, style: 'margin-right: 4px' }),
              translate('files.move.action'),
            ]
          ),
          h(
            Button,
            {
              size: 'small',
              type: 'default',
              disabled: shareDisabled,
              onClick: () => onShowFileShare(row),
            },
            () => [
              h(Share2, { size: 16, style: 'margin-right: 4px' }),
              translate('files.actions.share'),
            ]
          ),
          h(
            Button,
            {
              size: 'small',
              type: 'danger',
              disabled: rowDisabled,
              onClick: () => onDeleteFile(row.id),
            },
            () => [
              h(Trash2, { size: 16, style: 'margin-right: 4px' }),
              translate('files.actions.delete'),
            ]
          ),
        ])
      },
    },
  ]

  if (selectionEnabled) {
    columns.unshift({
      title: '',
      key: 'select',
      width: 48,
      align: 'center',
      ellipsis: false,
      titleRender: () =>
        h('input', {
          class: 'files-checkbox',
          type: 'checkbox',
          disabled: loading || deleting || pageRowIds.length === 0,
          checked: allRowsSelected,
          indeterminate: selectAllIndeterminate,
          onChange: (event) => onToggleSelectAll(Boolean(event?.target?.checked)),
        }),
      render: (row) => {
        const id = String(row?.id ?? '').trim()
        return h('input', {
          class: 'files-checkbox',
          type: 'checkbox',
          disabled: loading || deleting || !id,
          checked: selectedKeys.has(id),
          onChange: (event) => onToggleRowSelection(id, Boolean(event?.target?.checked)),
        })
      },
    })
  }

  return columns
}
