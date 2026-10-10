import { h } from 'vue'
import {
  Copy,
  Download,
  Eye,
  FolderInput,
  FolderOpen,
  Pencil,
  Share2,
  Trash2,
} from 'lucide-vue-next'
import Button from '../ui/button/Button.vue'
import Tooltip from '../ui/tooltip/Tooltip.vue'
import TableCellText from '../ui/table/TableCellText.vue'
import {
  formatMountBytes,
  formatMountDateTime,
  isMountedObjectPreviewSupported,
} from '../../utils/mountObjects.js'

export function buildMountTableColumns({
  t,
  locale = 'zh-CN',
  loading = false,
  deleting = false,
  deletingKey = '',
  onOpenFolder = () => {},
  onOpenPreview = () => {},
  onDownloadObject = () => {},
  onDeleteObject = () => {},
  onRenameObject = () => {},
  onMoveObject = () => {},
  onShareFolder = () => {},
  // 跨存储复制：仅多存储配置环境注入（单配置传 undefined 即隐藏入口）
  onCrossCopyObject = undefined,
} = {}) {
  const translate = typeof t === 'function' ? t : (key) => key

  return [
    {
      title: translate('mount.table.name'),
      key: 'name',
      align: 'left',
      ellipsis: true,
      render: (row) => {
        const isFolder = row.kind === 'folder'
        const displayName = isFolder ? `${row.name}/` : row.name

        const onClick = isFolder ? () => onOpenFolder(row.key) : undefined
        return h(Tooltip, { content: row.key }, () =>
          h(
            'span',
            {
              class: ['mount-name', isFolder ? 'is-folder' : ''],
              onClick,
            },
            [
              isFolder
                ? h('span', { class: 'mount-name-icon' }, [h(FolderOpen, { size: 16 })])
                : null,
              h('span', { class: 'mount-name-text' }, displayName),
            ]
          )
        )
      },
    },
    {
      title: translate('mount.table.size'),
      key: 'size',
      width: 120,
      align: 'center',
      ellipsis: true,
      render: (row) =>
        h(TableCellText, { value: row.kind === 'object' ? formatMountBytes(row.size) : '-' }),
    },
    {
      title: translate('mount.table.lastModified'),
      key: 'last_modified',
      width: 190,
      align: 'center',
      ellipsis: true,
      render: (row) =>
        h(TableCellText, {
          value: row.kind === 'object' ? formatMountDateTime(row.last_modified, locale) : '-',
        }),
    },
    {
      title: translate('mount.table.actions'),
      key: 'actions',
      width: locale === 'zh-CN' ? 600 : 680,
      align: 'center',
      ellipsis: false,
      render: (row) => {
        const isFolder = row.kind === 'folder'
        const isDeleting = deleting && deletingKey === row.key

        if (isFolder) {
          return h('div', { class: 'action-buttons' }, [
            h(
              Button,
              {
                size: 'small',
                type: 'default',
                disabled: loading || deleting,
                onClick: () => onOpenFolder(row.key),
              },
              () => [
                h(FolderOpen, { size: 16, style: 'margin-right: 4px' }),
                translate('mount.actions.open'),
              ]
            ),
            h(
              Button,
              {
                size: 'small',
                type: 'default',
                disabled: loading || deleting,
                onClick: () => onShareFolder(row.key),
              },
              () => [
                h(Share2, { size: 16, style: 'margin-right: 4px' }),
                translate('mount.shareFolder.actionShare'),
              ]
            ),
            h(
              Button,
              {
                size: 'small',
                type: 'danger',
                disabled: loading || deleting,
                loading: isDeleting,
                onClick: () => onDeleteObject(row.key),
              },
              () => [
                h(Trash2, { size: 16, style: 'margin-right: 4px' }),
                translate('mount.actions.delete'),
              ]
            ),
          ])
        }

        const canPreview = isMountedObjectPreviewSupported(row.key)

        const actionButtons = [
          h(
            Button,
            {
              size: 'small',
              type: 'default',
              disabled: loading || deleting || !canPreview,
              onClick: () => onOpenPreview(row.key),
            },
            () => [
              h(Eye, { size: 16, style: 'margin-right: 4px' }),
              translate('mount.actions.preview'),
            ]
          ),
          h(
            Button,
            {
              size: 'small',
              type: 'primary',
              disabled: loading || deleting,
              onClick: () => onDownloadObject(row.key),
            },
            () => [
              h(Download, { size: 16, style: 'margin-right: 4px' }),
              translate('mount.actions.download'),
            ]
          ),
          h(
            Button,
            {
              size: 'small',
              type: 'default',
              disabled: loading || deleting,
              onClick: () => onRenameObject(row.key),
            },
            () => [
              h(Pencil, { size: 16, style: 'margin-right: 4px' }),
              translate('mount.move.actionRename'),
            ]
          ),
          h(
            Button,
            {
              size: 'small',
              type: 'default',
              disabled: loading || deleting,
              onClick: () => onMoveObject(row.key),
            },
            () => [
              h(FolderInput, { size: 16, style: 'margin-right: 4px' }),
              translate('mount.move.actionMove'),
            ]
          ),
        ]

        // 跨存储复制入口：仅多存储配置环境（onCrossCopyObject 由父层按 configs.length>1 注入）
        if (typeof onCrossCopyObject === 'function') {
          actionButtons.push(
            h(
              Button,
              {
                size: 'small',
                type: 'default',
                disabled: loading || deleting,
                onClick: () => onCrossCopyObject(row.key),
              },
              () => [
                h(Copy, { size: 16, style: 'margin-right: 4px' }),
                translate('mount.crossCopy.action'),
              ]
            )
          )
        }

        actionButtons.push(
          h(
            Button,
            {
              size: 'small',
              type: 'danger',
              disabled: loading || deleting,
              loading: isDeleting,
              onClick: () => onDeleteObject(row.key),
            },
            () => [
              h(Trash2, { size: 16, style: 'margin-right: 4px' }),
              translate('mount.actions.delete'),
            ]
          )
        )

        return h('div', { class: 'action-buttons' }, actionButtons)
      },
    },
  ]
}
