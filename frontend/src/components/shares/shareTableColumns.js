import { h } from 'vue'
import { Copy, ExternalLink, History, Pencil, RefreshCw, Trash2 } from 'lucide-vue-next'
import Button from '../ui/button/Button.vue'
import Tag from '../ui/tag/Tag.vue'
import Tooltip from '../ui/tooltip/Tooltip.vue'
import TableCellText from '../ui/table/TableCellText.vue'
import {
  canOpenShare,
  formatShareVisits,
  getSharePasswordText,
  hasAccessLogConfig,
  hasEditableConfig,
  normalizeShareText,
  toShareSelectionKey,
  toShareStatusLabelKey,
  toShareStatusVariant,
  toShareTypeLabelKey,
} from '../../utils/shares.js'

export function buildSharesTableColumns({
  t,
  locale = 'zh-CN',
  uiTheme = '',
  isAdmin = false,
  loading = false,
  batchDisableSubmitting = false,
  pageRowIds = [],
  allRowsSelected = false,
  selectAllIndeterminate = false,
  selectedIdSet = new Set(),
  formatDateTime = () => '-',
  isActionLoading = () => false,
  onToggleSelectAll = () => {},
  onToggleRowSelection = () => {},
  onCopyShareLink = () => {},
  onOpenShareLink = () => {},
  onEditShare = () => {},
  onConfirmAction = () => {},
  onOpenAccessLog = () => {},
} = {}) {
  const translate = typeof t === 'function' ? t : (key) => key
  const selectedKeys = selectedIdSet instanceof Set ? selectedIdSet : new Set()

  const base = [
    {
      title: '',
      key: 'select',
      width: 48,
      align: 'center',
      ellipsis: false,
      titleRender: () =>
        h('input', {
          class: 'shares-checkbox',
          type: 'checkbox',
          disabled: loading || batchDisableSubmitting || pageRowIds.length === 0,
          checked: allRowsSelected,
          indeterminate: selectAllIndeterminate,
          onChange: (event) => onToggleSelectAll(Boolean(event?.target?.checked)),
        }),
      render: (row) => {
        const id = toShareSelectionKey(row)
        return h('input', {
          class: 'shares-checkbox',
          type: 'checkbox',
          disabled: loading || batchDisableSubmitting || !id,
          checked: selectedKeys.has(id),
          onChange: (event) => onToggleRowSelection(id, Boolean(event?.target?.checked)),
        })
      },
    },
    {
      title: translate('shares.columns.type'),
      key: 'type',
      width: 140,
      align: 'center',
      ellipsis: false,
      render: (row) =>
        h(Tag, { type: 'info', size: 'small' }, () => translate(toShareTypeLabelKey(row?.type))),
    },
    {
      title: translate('shares.columns.name'),
      key: 'name',
      width: 180,
      ellipsis: true,
      render: (row) => {
        const name = normalizeShareText(row?.resource_name)
        if (normalizeShareText(row?.type) === 'folder') {
          // folder 行展示分享前缀，并附带挂载点名便于区分同名目录
          const configName = normalizeShareText(row?.config_name)
          return h(TableCellText, {
            value: configName ? `${name}（${configName}）` : name || '/',
          })
        }
        return h(TableCellText, { value: name })
      },
    },
    {
      title: translate('shares.columns.link'),
      key: 'link',
      width: 220,
      align: 'center',
      ellipsis: false,
      render: (row) => {
        const shareUrl = normalizeShareText(row?.share_url) || '-'
        return h('div', { class: 'share-link-cell' }, [
          h('div', { class: 'share-link-text' }, [
            h(Tooltip, { content: shareUrl === '-' ? '' : shareUrl }, () =>
              h('span', { class: 'share-link-path' }, shareUrl)
            ),
          ]),
          h('div', { class: 'share-link-buttons' }, [
            h(
              Tooltip,
              {
                content: translate('shares.actions.copyLink'),
                disabled: !normalizeShareText(row?.share_url),
              },
              () =>
                h(
                  Button,
                  {
                    class: 'share-link-icon-button',
                    size: 'small',
                    type: 'default',
                    'aria-label': translate('shares.actions.copyLink'),
                    disabled: !normalizeShareText(row?.share_url) || loading,
                    onClick: () => onCopyShareLink(row),
                  },
                  () => h(Copy, { size: 16 })
                )
            ),
            h(
              Tooltip,
              {
                content: translate('shares.actions.openLink'),
                disabled: !normalizeShareText(row?.share_url) || !canOpenShare(row),
              },
              () =>
                h(
                  Button,
                  {
                    class: 'share-link-icon-button',
                    size: 'small',
                    type: 'default',
                    'aria-label': translate('shares.actions.openLink'),
                    disabled: !normalizeShareText(row?.share_url) || !canOpenShare(row) || loading,
                    onClick: () => onOpenShareLink(row),
                  },
                  () => h(ExternalLink, { size: 16 })
                )
            ),
          ]),
        ])
      },
    },
    {
      title: translate('shares.columns.status'),
      key: 'status',
      width: 110,
      align: 'center',
      ellipsis: false,
      render: (row) =>
        h(Tag, { type: toShareStatusVariant(row?.status), size: 'small' }, () =>
          translate(toShareStatusLabelKey(row?.status))
        ),
    },
    {
      title: translate('shares.columns.visits'),
      key: 'visits',
      width: 110,
      align: 'center',
      ellipsis: true,
      render: (row) => h(TableCellText, { value: formatShareVisits(row, translate) }),
    },
    {
      title: translate('shares.columns.expiresAt'),
      key: 'expiresAt',
      width: 180,
      align: 'center',
      ellipsis: true,
      render: (row) => h(TableCellText, { value: formatDateTime(row?.expires_at) }),
    },
    {
      title: translate('shares.columns.password'),
      key: 'password',
      width: 90,
      align: 'center',
      ellipsis: true,
      render: (row) => h(TableCellText, { value: getSharePasswordText(row, translate) }),
    },
    {
      title: translate('shares.columns.updatedAt'),
      key: 'updatedAt',
      width: 180,
      align: 'center',
      ellipsis: true,
      render: (row) => h(TableCellText, { value: formatDateTime(row?.updated_at) }),
    },
    {
      title: translate('shares.columns.actions'),
      key: 'actions',
      width:
        locale === 'zh-CN' ? (uiTheme === 'shadcn' ? 320 : 360) : uiTheme === 'shadcn' ? 360 : 430,
      align: 'center',
      ellipsis: false,
      fixed: 'right',
      render: (row) => {
        const buttons = []

        if (hasEditableConfig(row)) {
          buttons.push(
            h(
              Button,
              {
                size: 'small',
                type: 'default',
                disabled: loading || batchDisableSubmitting,
                onClick: () => onEditShare(row),
              },
              () => [
                h(Pencil, { size: 16, style: 'margin-right: 4px' }),
                translate('shares.actions.edit'),
              ]
            )
          )
        } else if (normalizeShareText(row?.type) === 'text_one_time') {
          // 仅一次性分享支持重置；folder 分享创建后短码固定，不走重置
          buttons.push(
            h(
              Button,
              {
                size: 'small',
                type: 'default',
                loading: isActionLoading('regenerate', row),
                disabled: loading || batchDisableSubmitting || isActionLoading('disable', row),
                onClick: () => onConfirmAction('regenerate', row),
              },
              () => [
                h(RefreshCw, { size: 16, style: 'margin-right: 4px' }),
                translate('shares.actions.regenerate'),
              ]
            )
          )
        }

        if (hasAccessLogConfig(row)) {
          buttons.push(
            h(
              Button,
              {
                size: 'small',
                type: 'default',
                disabled: loading || batchDisableSubmitting,
                onClick: () => onOpenAccessLog(row),
              },
              () => [
                h(History, { size: 16, style: 'margin-right: 4px' }),
                translate('shares.actions.accessLog'),
              ]
            )
          )
        }

        buttons.push(
          h(
            Button,
            {
              size: 'small',
              type: 'danger',
              loading: isActionLoading('disable', row),
              disabled: loading || batchDisableSubmitting || isActionLoading('regenerate', row),
              onClick: () => onConfirmAction('disable', row),
            },
            () => [
              h(Trash2, { size: 16, style: 'margin-right: 4px' }),
              translate('shares.actions.disable'),
            ]
          )
        )

        return h('div', { class: 'action-buttons' }, buttons)
      },
    },
  ]

  if (isAdmin) {
    base.splice(8, 0, {
      title: translate('shares.columns.owner'),
      key: 'owner',
      width: 140,
      align: 'center',
      ellipsis: true,
      render: (row) =>
        h(TableCellText, {
          value: normalizeShareText(row?.owner_username) || normalizeShareText(row?.owner_id),
        }),
    })
  }

  return base
}
