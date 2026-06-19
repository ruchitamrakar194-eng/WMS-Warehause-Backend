const express = require('express');
const router = express.Router();
const orderController = require('../../controllers/orderController');
const customerController = require('../../controllers/customerController');
const courierMappingController = require('../../controllers/courierMappingController');
const { authenticate, requireRole } = require('../../middlewares/auth');

router.use(authenticate);

router.get('/sales', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'inventory_manager', 'picker', 'packer', 'viewer'), orderController.list);
router.post('/sales/bulk-action', requireRole('super_admin', 'company_admin'), orderController.bulkAction);
router.post('/sales/import-csv', requireRole('super_admin', 'company_admin'), orderController.importCsv);
router.get('/sales/:id', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'inventory_manager', 'picker', 'packer', 'viewer'), orderController.getById);
router.post('/sales', requireRole('super_admin', 'company_admin'), orderController.create);
router.post('/sales/:id/allocate', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'inventory_manager'), orderController.allocate);
router.put('/sales/:id', requireRole('super_admin', 'company_admin'), orderController.update);
router.delete('/sales/:id', requireRole('super_admin', 'company_admin'), orderController.remove);

router.get('/saved-addresses', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'inventory_manager', 'picker', 'packer', 'viewer'), orderController.listSavedAddresses);
router.post('/saved-addresses', requireRole('super_admin', 'company_admin'), orderController.saveAddress);

router.get('/customers', requireRole('super_admin', 'company_admin', 'inventory_manager', 'picker', 'packer', 'viewer'), customerController.list);
router.get('/customers/:id', requireRole('super_admin', 'company_admin', 'inventory_manager', 'picker', 'packer', 'viewer'), customerController.getById);
router.post('/customers', requireRole('super_admin', 'company_admin'), customerController.create);
router.put('/customers/:id', requireRole('super_admin', 'company_admin'), customerController.update);
router.delete('/customers/:id', requireRole('super_admin', 'company_admin'), customerController.remove);

// Courier mappings CRUD and available services
router.get('/courier-mappings', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'inventory_manager'), courierMappingController.list);
router.get('/courier-mappings/available-services', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'inventory_manager'), courierMappingController.getAvailableServices);
router.post('/courier-mappings', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'inventory_manager'), courierMappingController.create);
router.put('/courier-mappings/:id', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'inventory_manager'), courierMappingController.update);
router.delete('/courier-mappings/:id', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'inventory_manager'), courierMappingController.remove);

module.exports = router;
