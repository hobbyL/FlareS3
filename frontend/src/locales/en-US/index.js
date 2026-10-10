import common from './common.js'
import errors from './errors.js'
import sidebar from './sidebar.js'
import components from './components.js'
import upload from './upload.js'
import search from './search.js'
import auth from './pages/auth.js'
import audit from './pages/audit.js'
import users from './pages/users.js'
import files from './pages/files.js'
import setup from './pages/setup.js'
import dashboard from './pages/dashboard.js'
import texts from './pages/texts.js'
import mount from './pages/mount.js'
import shares from './pages/shares.js'
import more from './pages/more.js'

export default {
  ...common,
  ...errors,
  ...sidebar,
  ...components,
  ...upload,
  ...search,
  ...auth,
  ...audit,
  ...users,
  ...files,
  ...setup,
  ...dashboard,
  ...texts,
  ...mount,
  ...shares,
  ...more,
}
