const { SalesOrder, OrderItem, Product, Customer, Company, PickList, PickListItem, PackingTask, Warehouse, Shipment, ProductStock, CourierMapping, sequelize } = require('../models');
const { Op } = require('sequelize');
const inventoryService = require('./inventoryService');

async function list(reqUser, query = {}) {
  const where = {};
  if (reqUser.role === 'super_admin') {
    if (query.companyId) where.companyId = query.companyId;
  } else {
    where.companyId = reqUser.companyId;
  }

  // Filter: Order Status
  if (query.status && query.status !== 'all') {
    if (typeof query.status === 'string' && query.status.includes(',')) {
      where.status = { [Op.in]: query.status.split(',') };
    } else if (Array.isArray(query.status)) {
      where.status = { [Op.in]: query.status };
    } else {
      where.status = query.status;
    }
  }

  // Filter: Channel
  if (query.salesChannel && query.salesChannel !== 'all') {
    where.salesChannel = query.salesChannel;
  }

  // Filter: Courier Name
  if (query.courierName && query.courierName !== 'all') {
    where.courierName = query.courierName;
  }

  // Filter: Courier Service
  if (query.courierService && query.courierService !== 'all') {
    where.courierService = query.courierService;
  }

  // Filter: Dates
  const dateField = query.useRequiredDespatch === 'true' ? 'requiredDespatchDate' : 'orderDate';
  if (query.startDate || query.endDate) {
    const dateCond = {};
    if (query.startDate) dateCond[Op.gte] = query.startDate;
    if (query.endDate) dateCond[Op.lte] = query.endDate;
    where[dateField] = dateCond;
  }

  // Search filter (SKU, postcode, customer name, order number, billing/shipping address)
  if (query.search) {
    const searchVal = `%${query.search}%`;
    where[Op.or] = [
      { orderNumber: { [Op.like]: searchVal } },
      { postcode: { [Op.like]: searchVal } },
      { country: { [Op.like]: searchVal } },
      { externalRef: { [Op.like]: searchVal } },
      { tags: { [Op.like]: searchVal } },
      { '$Client.name$': { [Op.like]: searchVal } },
      { '$Client.address$': { [Op.like]: searchVal } },
      { '$Client.city$': { [Op.like]: searchVal } },
      { '$Client.postcode$': { [Op.like]: searchVal } },
      { '$OrderItems.Product.sku$': { [Op.like]: searchVal } }
    ];
  }

  // Pagination
  const page = parseInt(query.page, 10) || 1;
  const limit = parseInt(query.pageSize, 10) || 20;
  const offset = (page - 1) * limit;

  const { rows, count } = await SalesOrder.findAndCountAll({
    where,
    order: [['createdAt', 'DESC']],
    include: [
      { association: 'Company', attributes: ['id', 'name', 'code'] },
      { association: 'Client', attributes: ['id', 'name', 'code', 'email', 'phone', 'contactPerson', 'address', 'city', 'state', 'country', 'postcode'] },
      {
        association: 'OrderItems',
        required: false,
        include: [
          { association: 'Product', attributes: ['id', 'name', 'sku', 'weight', 'weightUnit'] },
          { association: 'Warehouse', attributes: ['id', 'name'] },
          { association: 'Location', attributes: ['id', 'name'] }
        ]
      },
      { association: 'PickLists', include: [{ association: 'PickListItems', include: [{ association: 'Product' }] }] },
      { association: 'Shipment' },
    ],
    distinct: true,
    limit,
    offset,
  });

  return {
    items: rows.map((o) => o.get({ plain: true })),
    total: count,
    page,
    pageSize: limit
  };
}

async function getById(id, reqUser) {
  const order = await SalesOrder.findByPk(id, {
    include: [
      { association: 'Company' },
      { association: 'Client' },
      { association: 'OrderItems', include: ['Product', 'Warehouse', 'Location'] },
      { association: 'PickLists', include: ['PickListItems', 'Warehouse', 'User'] },
      { association: 'PackingTasks', include: ['User'] },
      { association: 'Shipment' },
    ],
  });
  if (!order) throw new Error('Order not found');
  if (reqUser.role !== 'super_admin' && order.companyId !== reqUser.companyId) throw new Error('Order not found');
  return order;
}

async function resolveCourierMapping(data, companyId, transaction = null) {
  if (data.requestedShippingService && data.requestedShippingService.trim()) {
    const serviceName = data.requestedShippingService.trim();
    const mapping = await CourierMapping.findOne({
      where: {
        companyId,
        requestedService: serviceName
      },
      transaction
    });
    if (mapping) {
      data.courierName = mapping.courierName;
      data.courierService = mapping.courierService;
    }
  }
}

async function create(data, reqUser) {
  if (reqUser.role !== 'super_admin' && reqUser.role !== 'company_admin') throw new Error('Only Company Admin can create sales orders');
  const companyId = reqUser.companyId;

  const t = await sequelize.transaction();
  try {
    await resolveCourierMapping(data, companyId, t);
    const count = await SalesOrder.count({ where: { companyId }, transaction: t });
    const sequenceNumber = count + 1;
    const orderNumber = data.orderNumber && data.orderNumber.trim()
      ? data.orderNumber.trim()
      : `ORD-${Date.now()}-${String(sequenceNumber).padStart(4, '0')}`;

    // 1. If saveAddress is true, save this address to the customers table
    let customerId = data.customerId || null;
    if (data.saveAddress && !customerId && data.recipientName) {
      const newCustomer = await Customer.create({
        companyId,
        name: data.recipientName,
        contactPerson: data.recipientName,
        phone: data.phone || null,
        email: data.email || null,
        country: data.country || null,
        state: data.county || null,
        city: data.town || null,
        address: [data.addressLine1, data.addressLine2, data.addressLine3].filter(Boolean).join('\n'),
        postcode: data.postcode || null,
        status: 'ACTIVE'
      }, { transaction: t });
      customerId = newCustomer.id;
    }

    // 2. Create the SalesOrder record
    const order = await SalesOrder.create({
      companyId,
      orderNumber,
      sequenceNumber,
      customerId: customerId,
      orderDate: data.orderDate || null,
      requiredDate: data.requiredDate || null,
      requiredDespatchDate: data.requiredDespatchDate || data.requiredDate || null,
      requiredDeliveryDate: data.requiredDeliveryDate || data.requiredDate || null,
      priority: data.priority || 'MEDIUM',
      salesChannel: data.salesChannel || 'DIRECT',
      orderType: data.orderType || null,
      referenceNumber: data.referenceNumber || null,
      notes: data.notes || null,
      status: 'DRAFT',
      totalAmount: 0,
      createdBy: reqUser.id,
      recipientName: data.recipientName || null,
      addressLine1: data.addressLine1 || null,
      addressLine2: data.addressLine2 || null,
      addressLine3: data.addressLine3 || null,
      town: data.town || null,
      county: data.county || null,
      postcode: data.postcode || null,
      country: data.country || null,
      phone: data.phone || null,
      email: data.email || null,
      courierName: data.courierName || null,
      courierService: data.courierService || null,
      requestedShippingService: data.requestedShippingService || null,
      noOfParcels: data.noOfParcels || 1,
      totalWeight: 0.0,
      tags: data.tags || null,
      externalRef: data.externalRef || null,
    }, { transaction: t });

    let total = 0;
    let calculatedWeight = 0;
    const warehouse = await Warehouse.findOne({ where: { companyId, status: 'ACTIVE' }, transaction: t });
    let hasSoftAllocations = false;

    if (data.items && data.items.length) {
      for (const row of data.items) {
        const product = await Product.findByPk(row.productId, { transaction: t });
        if (!product || product.companyId !== companyId) continue;

        const unitPrice = row.unitPrice ?? product.price;
        const qty = row.quantity || 1;
        calculatedWeight += (Number(product.weight || 0) * qty);

        // Resolve Target Warehouse
        let targetWarehouseId = row.warehouseId || warehouse?.id;
        if (!targetWarehouseId) {
          const firstStock = await ProductStock.findOne({
            where: { productId: product.id, companyId, quantity: { [Op.gt]: sequelize.col('reserved') }, status: 'ACTIVE' },
            include: [{ model: Warehouse, where: { status: 'ACTIVE' }, required: true, attributes: [] }],
            transaction: t
          });
          targetWarehouseId = firstStock?.warehouseId;
        }
        if (!targetWarehouseId) {
          throw new Error(`Insufficient available stock for product ${product.sku} across all warehouses.`);
        }

        // Option 2: Manual Location Allocation
        if (row.locationId) {
          const stockRow = await ProductStock.findOne({
            where: {
              productId: product.id,
              warehouseId: targetWarehouseId,
              locationId: row.locationId,
              batchNumber: row.batchNumber || null,
              bestBeforeDate: row.bestBeforeDate || null,
              companyId,
              status: 'ACTIVE'
            },
            include: [{ model: Warehouse, where: { status: 'ACTIVE' }, required: true, attributes: [] }],
            transaction: t
          });
          if (!stockRow || (stockRow.quantity - stockRow.reserved) < qty) {
            throw new Error(`Insufficient available stock at location selection for product ${product.sku}.`);
          }

          // Hard reserve in ProductStock row
          await stockRow.increment('reserved', { by: qty, transaction: t });
          
          // Soft reserve in warehouse total
          await inventoryService.reserveStockSoft({
            productId: product.id,
            warehouseId: targetWarehouseId,
            quantity: qty,
            referenceId: order.orderNumber,
            reason: `Order: ${order.orderNumber}`,
            userId: reqUser.id
          }, t);

          // Create hard-allocated OrderItem
          await OrderItem.create({
            salesOrderId: order.id,
            productId: product.id,
            quantity: qty,
            unitPrice: unitPrice,
            warehouseId: targetWarehouseId,
            locationId: row.locationId,
            batchNumber: row.batchNumber || null,
            bestBeforeDate: row.bestBeforeDate || null
          }, { transaction: t });
        } else {
          // Option 1: Soft Allocation
          hasSoftAllocations = true;

          // Verify total stock in selected warehouse is sufficient for soft reservation
          const stocks = await ProductStock.findAll({
            where: { productId: product.id, warehouseId: targetWarehouseId, companyId, status: 'ACTIVE' },
            include: [{ model: Warehouse, where: { status: 'ACTIVE' }, required: true, attributes: [] }],
            transaction: t
          });
          const totalAvail = stocks.reduce((sum, s) => sum + (Number(s.quantity) - Number(s.reserved)), 0);
          if (totalAvail < qty) {
            throw new Error(`Insufficient available warehouse stock for product ${product.sku}.`);
          }

          // Soft reserve in warehouse total only
          await inventoryService.reserveStockSoft({
            productId: product.id,
            warehouseId: targetWarehouseId,
            quantity: qty,
            referenceId: order.orderNumber,
            reason: `Order: ${order.orderNumber}`,
            userId: reqUser.id
          }, t);

          // Create soft-allocated OrderItem (no locationId)
          await OrderItem.create({
            salesOrderId: order.id,
            productId: product.id,
            quantity: qty,
            unitPrice: unitPrice,
            warehouseId: targetWarehouseId
          }, { transaction: t });
        }

        total += Number(unitPrice) * qty;
      }
      
      await order.update({ totalAmount: total, totalWeight: calculatedWeight }, { transaction: t });
    }

    // 5. Create PickLists only if all items are fully allocated (meaning no soft allocations)
    if (!hasSoftAllocations && data.items && data.items.length) {
      const orderItemsForPick = await OrderItem.findAll({ where: { salesOrderId: order.id }, transaction: t });
      const warehouseGroups = {};
      orderItemsForPick.forEach(item => {
        if (!warehouseGroups[item.warehouseId]) warehouseGroups[item.warehouseId] = [];
        warehouseGroups[item.warehouseId].push(item);
      });

      for (const whId in warehouseGroups) {
        const pickList = await PickList.create({
          salesOrderId: order.id,
          warehouseId: whId,
          status: 'NOT_STARTED',
        }, { transaction: t });

        for (const item of warehouseGroups[whId]) {
          await PickListItem.create({
            pickListId: pickList.id,
            productId: item.productId,
            quantityRequired: item.quantity,
            quantityPicked: 0,
          }, { transaction: t });
        }
        await PackingTask.create({
          salesOrderId: order.id,
          pickListId: pickList.id,
          status: 'NOT_STARTED',
        }, { transaction: t });
      }

      await order.update({ status: 'CONFIRMED' }, { transaction: t });
    } else {
      // It remains DRAFT if soft allocations exist
      await order.update({ status: 'DRAFT' }, { transaction: t });
    }

    await t.commit();
    return getById(order.id, reqUser);
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

async function update(id, data, reqUser) {
  const t = await sequelize.transaction();
  try {
    const order = await SalesOrder.findByPk(id, {
      include: [{ association: 'OrderItems' }, { association: 'PickLists' }],
      transaction: t,
      lock: t.LOCK.UPDATE
    });
    if (!order) throw new Error('Order not found');
    if (reqUser.role !== 'super_admin' && order.companyId !== reqUser.companyId) throw new Error('Order not found');

    const allowedStatuses = ['DRAFT', 'CONFIRMED', 'BACKORDER'];
    if (!allowedStatuses.includes((order.status || '').toUpperCase())) {
      throw new Error('Only DRAFT, CONFIRMED, or BACKORDER orders can be edited');
    }

    // 1. Unreserve OLD items correctly (only if we are updating items)
    if (data.items && Array.isArray(data.items) && order.OrderItems) {
      for (const item of order.OrderItems) {
        const whId = item.warehouseId || order.PickLists?.[0]?.warehouseId;
        if (!whId) continue;
        
        if (item.locationId) {
          const stockRow = await ProductStock.findOne({
            where: {
              productId: item.productId,
              warehouseId: whId,
              locationId: item.locationId,
              batchNumber: item.batchNumber || null,
              bestBeforeDate: item.bestBeforeDate || null,
              companyId: order.companyId,
              status: 'ACTIVE'
            },
            transaction: t
          });
          if (stockRow) {
            const toDeduct = Math.min(Number(stockRow.reserved), item.quantity);
            await stockRow.decrement('reserved', { by: toDeduct, transaction: t });
          }
          await inventoryService.unreserveStockSoft({
            productId: item.productId,
            warehouseId: whId,
            quantity: item.quantity,
            referenceId: order.orderNumber,
            reason: `Order Update (Deallocate): ${order.orderNumber}`,
            userId: reqUser.id
          }, t);
        } else {
          await inventoryService.unreserveStockSoft({
            productId: item.productId,
            warehouseId: whId,
            quantity: item.quantity,
            referenceId: order.orderNumber,
            reason: `Order Update (Deallocate): ${order.orderNumber}`,
            userId: reqUser.id
          }, t);
        }
      }
    }

    // 2. Update Order Details
    await order.update({
      customerId: data.customerId !== undefined ? data.customerId : order.customerId,
      orderDate: data.orderDate !== undefined ? data.orderDate : order.orderDate,
      requiredDate: data.requiredDate !== undefined ? data.requiredDate : order.requiredDate,
      requiredDespatchDate: data.requiredDespatchDate !== undefined ? data.requiredDespatchDate : (data.requiredDate !== undefined ? data.requiredDate : order.requiredDespatchDate),
      requiredDeliveryDate: data.requiredDeliveryDate !== undefined ? data.requiredDeliveryDate : (data.requiredDate !== undefined ? data.requiredDate : order.requiredDeliveryDate),
      priority: data.priority !== undefined ? data.priority : order.priority,
      salesChannel: data.salesChannel !== undefined ? data.salesChannel : order.salesChannel,
      orderType: data.orderType !== undefined ? data.orderType : order.orderType,
      referenceNumber: data.referenceNumber !== undefined ? data.referenceNumber : order.referenceNumber,
      notes: data.notes !== undefined ? data.notes : order.notes,
      
      recipientName: data.recipientName !== undefined ? data.recipientName : order.recipientName,
      addressLine1: data.addressLine1 !== undefined ? data.addressLine1 : order.addressLine1,
      addressLine2: data.addressLine2 !== undefined ? data.addressLine2 : order.addressLine2,
      addressLine3: data.addressLine3 !== undefined ? data.addressLine3 : order.addressLine3,
      town: data.town !== undefined ? data.town : order.town,
      county: data.county !== undefined ? data.county : order.county,
      postcode: data.postcode !== undefined ? data.postcode : order.postcode,
      country: data.country !== undefined ? data.country : order.country,
      phone: data.phone !== undefined ? data.phone : order.phone,
      email: data.email !== undefined ? data.email : order.email,
      courierName: data.courierName !== undefined ? data.courierName : order.courierName,
      courierService: data.courierService !== undefined ? data.courierService : order.courierService,
      requestedShippingService: data.requestedShippingService !== undefined ? data.requestedShippingService : order.requestedShippingService,
      noOfParcels: data.noOfParcels !== undefined ? data.noOfParcels : order.noOfParcels,
      totalWeight: order.totalWeight,
      tags: data.tags !== undefined ? data.tags : order.tags,
      externalRef: data.externalRef !== undefined ? data.externalRef : order.externalRef,
    }, { transaction: t });

    // 3. Update Items & Reserve NEW ones
    if (data.items && Array.isArray(data.items)) {
      await OrderItem.destroy({ where: { salesOrderId: order.id }, transaction: t });
      let total = 0;
      let calculatedWeight = 0;
      const currentWarehouse = await Warehouse.findOne({ where: { companyId: order.companyId, status: 'ACTIVE' }, transaction: t });
      let hasSoftAllocations = false;

      for (const row of data.items) {
        const product = await Product.findByPk(row.productId, { transaction: t });
        if (!product || product.companyId !== order.companyId) continue;

        const unitPrice = row.unitPrice ?? product.price;
        const qty = row.quantity || 1;
        calculatedWeight += (Number(product.weight || 0) * qty);

        let targetWarehouseId = row.warehouseId || currentWarehouse?.id;
        if (!targetWarehouseId) {
          throw new Error(`Warehouse is required for product ${product.sku}`);
        }

        if (row.locationId) {
          const stockRow = await ProductStock.findOne({
            where: {
              productId: product.id,
              warehouseId: targetWarehouseId,
              locationId: row.locationId,
              batchNumber: row.batchNumber || null,
              bestBeforeDate: row.bestBeforeDate || null,
              companyId: order.companyId,
              status: 'ACTIVE'
            },
            include: [{ model: Warehouse, where: { status: 'ACTIVE' }, required: true, attributes: [] }],
            transaction: t
          });
          if (!stockRow || (stockRow.quantity - stockRow.reserved) < qty) {
            throw new Error(`Insufficient available stock at location selection for product ${product.sku}.`);
          }

          await stockRow.increment('reserved', { by: qty, transaction: t });
          await inventoryService.reserveStockSoft({
            productId: product.id,
            warehouseId: targetWarehouseId,
            quantity: qty,
            referenceId: order.orderNumber,
            reason: `Order: ${order.orderNumber}`,
            userId: reqUser.id
          }, t);

          await OrderItem.create({
            salesOrderId: order.id,
            productId: product.id,
            quantity: qty,
            unitPrice: unitPrice,
            warehouseId: targetWarehouseId,
            locationId: row.locationId,
            batchNumber: row.batchNumber || null,
            bestBeforeDate: row.bestBeforeDate || null
          }, { transaction: t });
        } else {
          // Option 1: Soft Allocation
          hasSoftAllocations = true;

          await inventoryService.reserveStockSoft({
            productId: product.id,
            warehouseId: targetWarehouseId,
            quantity: qty,
            referenceId: order.orderNumber,
            reason: `Order: ${order.orderNumber}`,
            userId: reqUser.id
          }, t);

          await OrderItem.create({
            salesOrderId: order.id,
            productId: product.id,
            quantity: qty,
            unitPrice: unitPrice,
            warehouseId: targetWarehouseId
          }, { transaction: t });
        }

        total += Number(unitPrice) * qty;
      }
      await order.update({ totalAmount: total, totalWeight: calculatedWeight }, { transaction: t });

      // Rebuild picklists if no soft allocations are present
      if (!hasSoftAllocations && data.items.length) {
        const existingPickLists = await PickList.findAll({ where: { salesOrderId: order.id }, transaction: t });
        for (const pl of existingPickLists) {
          await PickListItem.destroy({ where: { pickListId: pl.id }, transaction: t });
          await PackingTask.destroy({ where: { pickListId: pl.id }, transaction: t });
          await pl.destroy({ transaction: t });
        }
        await PackingTask.destroy({ where: { salesOrderId: order.id }, transaction: t });

        const orderItemsForPick = await OrderItem.findAll({ where: { salesOrderId: order.id }, transaction: t });
        const warehouseGroups = {};
        orderItemsForPick.forEach(item => {
          if (!warehouseGroups[item.warehouseId]) warehouseGroups[item.warehouseId] = [];
          warehouseGroups[item.warehouseId].push(item);
        });

        for (const whId in warehouseGroups) {
          const pickList = await PickList.create({
            salesOrderId: order.id,
            warehouseId: whId,
            status: 'NOT_STARTED',
          }, { transaction: t });

          for (const item of warehouseGroups[whId]) {
            await PickListItem.create({
              pickListId: pickList.id,
              productId: item.productId,
              quantityRequired: item.quantity,
              quantityPicked: 0,
            }, { transaction: t });
          }
          await PackingTask.create({
            salesOrderId: order.id,
            pickListId: pickList.id,
            status: 'NOT_STARTED',
          }, { transaction: t });
        }

        await order.update({ status: 'CONFIRMED' }, { transaction: t });
      } else {
        await order.update({ status: 'DRAFT' }, { transaction: t });
      }
    }

    await t.commit();
    return getById(order.id, reqUser);
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

async function remove(id, reqUser) {
  const t = await sequelize.transaction();
  try {
    const order = await SalesOrder.findByPk(id, {
      include: [{ association: 'OrderItems' }, { association: 'PickLists' }],
      transaction: t,
      lock: t.LOCK.UPDATE
    });
    if (!order) throw new Error('Order not found');
    if (reqUser.role !== 'super_admin' && order.companyId !== reqUser.companyId) throw new Error('Order not found');

    const allowedStatuses = ['DRAFT', 'CONFIRMED', 'BACKORDER', 'PICK_LIST_CREATED'];
    const status = (order.status || '').toUpperCase();
    if (!allowedStatuses.includes(status)) {
      throw new Error(`This sales order cannot be deleted. Current status: ${status || 'Unknown'}.`);
    }

    // UNRESERVE STOCK
    if (order.OrderItems) {
      for (const item of order.OrderItems) {
        const warehouseId = item.warehouseId || order.PickLists?.[0]?.warehouseId;
        if (!warehouseId) continue;

        if (item.locationId) {
          const stockRow = await ProductStock.findOne({
            where: {
              productId: item.productId,
              warehouseId,
              locationId: item.locationId,
              batchNumber: item.batchNumber || null,
              bestBeforeDate: item.bestBeforeDate || null,
              companyId: order.companyId,
              status: 'ACTIVE'
            },
            transaction: t
          });
          if (stockRow) {
            const toDeduct = Math.min(Number(stockRow.reserved), item.quantity);
            await stockRow.decrement('reserved', { by: toDeduct, transaction: t });
          }
          await inventoryService.unreserveStockSoft({
            productId: item.productId,
            warehouseId,
            quantity: item.quantity,
            referenceId: order.orderNumber,
            reason: `Order Deleted (Deallocate): ${order.orderNumber}`,
            userId: reqUser.id
          }, t);
        } else {
          await inventoryService.unreserveStockSoft({
            productId: item.productId,
            warehouseId,
            quantity: item.quantity,
            referenceId: order.orderNumber,
            reason: `Order Deleted (Deallocate): ${order.orderNumber}`,
            userId: reqUser.id
          }, t);
        }
      }
    }

    await OrderItem.destroy({ where: { salesOrderId: order.id }, transaction: t });
    const pickLists = await PickList.findAll({ where: { salesOrderId: order.id }, transaction: t });
    for (const pl of pickLists) {
      await PickListItem.destroy({ where: { pickListId: pl.id }, transaction: t });
      await PackingTask.destroy({ where: { pickListId: pl.id }, transaction: t });
      await pl.destroy({ transaction: t });
    }
    await PackingTask.destroy({ where: { salesOrderId: order.id }, transaction: t });
    await Shipment.destroy({ where: { salesOrderId: order.id }, transaction: t });
    await order.destroy({ transaction: t });

    await t.commit();
    return { message: 'Order deleted and stock unreserved' };
  } catch (err) {
    await t.rollback();
    throw err;
  }
}


async function bulkAction(data, reqUser) {
  const { action, ids, tag } = data;
  if (!ids || !Array.isArray(ids) || ids.length === 0) throw new Error('No order IDs provided');

  const companyWhere = reqUser.role === 'super_admin' ? {} : { companyId: reqUser.companyId };

  const orders = await SalesOrder.findAll({
    where: { id: { [Op.in]: ids }, ...companyWhere },
    include: [{ association: 'OrderItems' }, { association: 'PickLists' }]
  });

  let affected = 0;

  for (const order of orders) {
    try {
      if (action === 'delete') {
        const t = await sequelize.transaction();
        try {
          if (order.OrderItems) {
            for (const item of order.OrderItems) {
              const warehouseId = item.warehouseId || order.PickLists?.[0]?.warehouseId;
              if (!warehouseId) continue;

              if (item.locationId) {
                const stockRow = await ProductStock.findOne({
                  where: {
                    productId: item.productId,
                    warehouseId,
                    locationId: item.locationId,
                    batchNumber: item.batchNumber || null,
                    bestBeforeDate: item.bestBeforeDate || null,
                    companyId: order.companyId,
                    status: 'ACTIVE'
                  },
                  transaction: t
                });
                if (stockRow) {
                  const toDeduct = Math.min(Number(stockRow.reserved), item.quantity);
                  await stockRow.decrement('reserved', { by: toDeduct, transaction: t });
                }
                await inventoryService.unreserveStockSoft({
                  productId: item.productId,
                  warehouseId,
                  quantity: item.quantity,
                  referenceId: order.orderNumber,
                  reason: `Order Bulk Deleted (Deallocate): ${order.orderNumber}`,
                  userId: reqUser.id
                }, t);
              } else {
                await inventoryService.unreserveStockSoft({
                  productId: item.productId,
                  warehouseId,
                  quantity: item.quantity,
                  referenceId: order.orderNumber,
                  reason: `Order Bulk Deleted (Deallocate): ${order.orderNumber}`,
                  userId: reqUser.id
                }, t);
              }
            }
          }
          await OrderItem.destroy({ where: { salesOrderId: order.id }, transaction: t });
          const pickLists = await PickList.findAll({ where: { salesOrderId: order.id }, transaction: t });
          for (const pl of pickLists) {
            await PickListItem.destroy({ where: { pickListId: pl.id }, transaction: t });
            await PackingTask.destroy({ where: { pickListId: pl.id }, transaction: t });
            await pl.destroy({ transaction: t });
          }
          await PackingTask.destroy({ where: { salesOrderId: order.id }, transaction: t });
          await Shipment.destroy({ where: { salesOrderId: order.id }, transaction: t });
          await order.destroy({ transaction: t });
          await t.commit();
          affected++;
        } catch (e) {
          await t.rollback();
        }
      } else if (action === 'mark_despatched') {
        const t = await sequelize.transaction();
        try {
          await order.update({ status: 'SHIPPED' }, { transaction: t });
          
          let shipment = await Shipment.findOne({ where: { salesOrderId: order.id }, transaction: t });
          if (!shipment) {
            shipment = await Shipment.create({
              salesOrderId: order.id,
              companyId: order.companyId,
              packedBy: reqUser.id,
              courierName: order.courierName || 'Manual',
              trackingNumber: order.trackingNumber || null,
              weight: order.totalWeight || null,
              dispatchDate: new Date().toISOString().slice(0, 10),
              deliveryStatus: 'SHIPPED',
              stockDeducted: false
            }, { transaction: t });
          } else {
            await shipment.update({
              deliveryStatus: 'SHIPPED',
              dispatchDate: shipment.dispatchDate || new Date().toISOString().slice(0, 10)
            }, { transaction: t });
          }

          if (!shipment.stockDeducted) {
            const orderItems = await OrderItem.findAll({ where: { salesOrderId: order.id }, transaction: t });
            let warehouseId = order.PickLists?.[0]?.warehouseId;
            if (!warehouseId && orderItems.length > 0) {
              warehouseId = orderItems[0].warehouseId;
            }
            if (warehouseId) {
              for (const item of orderItems) {
                await inventoryService.shipStock({
                  productId: item.productId,
                  companyId: order.companyId,
                  warehouseId,
                  clientId: order.customerId || null,
                  quantity: item.quantity,
                  referenceId: `SHIP:${shipment.id}`,
                  userId: reqUser.id
                }, t);
              }
              await shipment.update({ stockDeducted: true }, { transaction: t });
            }
          }

          await t.commit();
          affected++;
        } catch (e) {
          await t.rollback();
          throw e;
        }
      } else if (action === 'confirm' || action === 'uncancel') {
        const t = await sequelize.transaction();
        try {
          await order.update({ status: 'CONFIRMED' }, { transaction: t });
          await t.commit();
          
          const allocationService = require('./allocationService');
          await allocationService.allocateOrder(order.id);
          affected++;
        } catch (e) {
          affected++; // Ignore allocation errors, still count as confirmed/uncancelled
        }
      } else if (action === 'cancel') {
        const t = await sequelize.transaction();
        try {
          if (order.status !== 'CANCELLED') {
            if (order.OrderItems) {
              for (const item of order.OrderItems) {
                const warehouseId = item.warehouseId || order.PickLists?.[0]?.warehouseId;
                if (!warehouseId) continue;

                if (item.locationId) {
                  const stockRow = await ProductStock.findOne({
                    where: {
                      productId: item.productId,
                      warehouseId,
                      locationId: item.locationId,
                      batchNumber: item.batchNumber || null,
                      bestBeforeDate: item.bestBeforeDate || null,
                      companyId: order.companyId,
                      status: 'ACTIVE'
                    },
                    transaction: t
                  });
                  if (stockRow) {
                    const toDeduct = Math.min(Number(stockRow.reserved), item.quantity);
                    await stockRow.decrement('reserved', { by: toDeduct, transaction: t });
                  }
                  await inventoryService.unreserveStockSoft({
                    productId: item.productId,
                    warehouseId,
                    quantity: item.quantity,
                    referenceId: order.orderNumber,
                    reason: `Order Cancelled (Deallocate): ${order.orderNumber}`,
                    userId: reqUser.id
                  }, t);
                } else {
                  await inventoryService.unreserveStockSoft({
                    productId: item.productId,
                    warehouseId,
                    quantity: item.quantity,
                    referenceId: order.orderNumber,
                    reason: `Order Cancelled (Deallocate): ${order.orderNumber}`,
                    userId: reqUser.id
                  }, t);
                }
              }
            }
          }

          const pickLists = await PickList.findAll({ where: { salesOrderId: order.id }, transaction: t });
          for (const pl of pickLists) {
            await PickListItem.destroy({ where: { pickListId: pl.id }, transaction: t });
            await PackingTask.destroy({ where: { pickListId: pl.id }, transaction: t });
            await pl.destroy({ transaction: t });
          }
          await PackingTask.destroy({ where: { salesOrderId: order.id }, transaction: t });

          if (order.OrderItems) {
            for (const item of order.OrderItems) {
              await item.update({
                locationId: null,
                batchNumber: null,
                bestBeforeDate: null
              }, { transaction: t });
            }
          }

          await order.update({ status: 'CANCELLED' }, { transaction: t });
          await t.commit();
          affected++;
        } catch (e) {
          await t.rollback();
          throw e;
        }
      } else if (action === 'place_on_backorder') {
        await order.update({ status: 'BACKORDER' });
        affected++;
      } else if (action === 'mark_picked') {
        const t = await sequelize.transaction();
        try {
          await order.update({ status: 'PICKED' }, { transaction: t });

          const existingPickLists = await PickList.findAll({ where: { salesOrderId: order.id }, transaction: t });
          if (existingPickLists.length > 0) {
            for (const pl of existingPickLists) {
              await pl.update({ status: 'PICKED' }, { transaction: t });
              
              const items = await PickListItem.findAll({ where: { pickListId: pl.id }, transaction: t });
              for (const item of items) {
                await item.update({ quantityPicked: item.quantityRequired }, { transaction: t });
              }

              const existingTask = await PackingTask.findOne({ where: { pickListId: pl.id }, transaction: t });
              if (!existingTask) {
                await PackingTask.create({
                  salesOrderId: order.id,
                  pickListId: pl.id,
                  status: 'NOT_STARTED',
                  warehouseId: pl.warehouseId
                }, { transaction: t });
              }
            }
          } else {
            const orderItems = order.OrderItems || [];
            let defaultWhId = null;
            if (orderItems.some(item => !item.warehouseId)) {
              const defaultWh = await Warehouse.findOne({ transaction: t });
              if (defaultWh) defaultWhId = defaultWh.id;
            }

            const warehouseGroups = {};
            for (const item of orderItems) {
              const whId = item.warehouseId || defaultWhId || 1;
              if (!warehouseGroups[whId]) warehouseGroups[whId] = [];
              warehouseGroups[whId].push(item);
            }

            for (const whId in warehouseGroups) {
              const pl = await PickList.create({
                salesOrderId: order.id,
                warehouseId: whId,
                status: 'PICKED'
              }, { transaction: t });

              for (const item of warehouseGroups[whId]) {
                await PickListItem.create({
                  pickListId: pl.id,
                  productId: item.productId,
                  quantityRequired: item.quantity,
                  quantityPicked: item.quantity
                }, { transaction: t });
              }

              await PackingTask.create({
                salesOrderId: order.id,
                pickListId: pl.id,
                status: 'NOT_STARTED',
                warehouseId: whId
              }, { transaction: t });
            }
          }

          await t.commit();
          affected++;
        } catch (e) {
          await t.rollback();
          throw e;
        }
      } else if (action === 'add_tag') {
        if (tag) {
          const existing = (order.tags || '').split(',').map(t => t.trim()).filter(Boolean);
          if (!existing.includes(tag)) existing.push(tag);
          await order.update({ tags: existing.join(', ') });
        }
        affected++;
      } else if (action === 'remove_tag') {
        if (tag) {
          const existing = (order.tags || '').split(',').map(t => t.trim()).filter(t => t && t !== tag);
          await order.update({ tags: existing.join(', ') });
        }
      } else if (action === 'allocate_stock') {
        const allocationService = require('./allocationService');
        await allocationService.allocateOrder(order.id);
        affected++;
      } else if (action === 'export_csv') {
        // handled client-side
        affected++;
      }

    } catch (e) {
      // skip individual failures
    }
  }

  return { affected, action };
}

async function allocateAllOrders(reqUser) {
  const companyWhere = reqUser.role === 'super_admin' ? {} : { companyId: reqUser.companyId };
  // Find all orders that are in DRAFT or BACKORDER status
  const orders = await SalesOrder.findAll({
    where: {
      status: { [Op.in]: ['DRAFT', 'BACKORDER'] },
      ...companyWhere
    },
    order: [
      ['orderDate', 'ASC'],
      ['id', 'ASC']
    ]
  });

  const allocationService = require('./allocationService');
  let successCount = 0;
  let backorderCount = 0;
  let errorCount = 0;

  for (const order of orders) {
    try {
      const result = await allocationService.allocateOrder(order.id);
      if (result.success) {
        successCount++;
      } else {
        backorderCount++;
      }
    } catch (e) {
      errorCount++;
    }
  }

  return { total: orders.length, successCount, backorderCount, errorCount };
}

async function importCsv(rows, reqUser) {
  const companyId = reqUser.companyId;
  const t = await sequelize.transaction();

  try {
    const ordersGrouped = {};

    for (const row of rows) {
      const recipientName = (row['Recipient Name'] || row.recipientName || '').trim();
      if (!recipientName) continue;

      const orderNumber = (row['Order Number'] || row.orderNumber || '').trim();
      const postcode = (row['Postcode'] || row.postcode || '').trim();
      const orderDate = (row['Order Date'] || row.orderDate || '').trim() || new Date().toISOString().split('T')[0];

      const groupKey = orderNumber ? `ord-${orderNumber}` : `temp-${recipientName}-${postcode}-${orderDate}`;

      if (!ordersGrouped[groupKey]) {
        ordersGrouped[groupKey] = {
          orderNumber: orderNumber || null,
          recipientName,
          addressLine1: (row['Address Line 1'] || row.addressLine1 || '').trim(),
          addressLine2: (row['Address Line 2'] || row.addressLine2 || '').trim() || null,
          addressLine3: (row['Address Line 3'] || row.addressLine3 || '').trim() || null,
          town: (row['Town'] || row.town || '').trim(),
          county: (row['County'] || row.county || '').trim() || null,
          postcode,
          country: (row['Country'] || row.country || '').trim() || 'UNITED KINGDOM',
          phone: (row['Phone'] || row.phone || '').trim() || null,
          email: (row['Email'] || row.email || '').trim() || null,
          orderDate,
          requiredDate: (row['Required Delivery Date'] || row.requiredDate || '').trim() || null,
          priority: (row['Priority'] || row.priority || 'MEDIUM').trim().toUpperCase(),
          salesChannel: (row['Sales Channel'] || row.salesChannel || 'DIRECT').trim().toUpperCase(),
          orderType: (row['Order Type'] || row.orderType || null),
          referenceNumber: (row['Reference Number'] || row.referenceNumber || null),
          notes: (row['Notes'] || row.notes || null),
          courierName: (row['Courier Name'] || row.courierName || null),
          courierService: (row['Courier Service'] || row.courierService || null),
          requestedShippingService: (row['Requested Shipping Service'] || row.requestedShippingService || null),
          noOfParcels: parseInt(row['No. of Parcels'] || row.noOfParcels, 10) || 1,
          tags: (row['Tags'] || row.tags || null),
          externalRef: (row['External Ref'] || row.externalRef || null),
          items: []
        };
        await resolveCourierMapping(ordersGrouped[groupKey], companyId, t);
      }

      const sku = (row['SKU'] || row.sku || '').trim();
      const qty = parseInt(row['Quantity'] || row.quantity, 10) || 1;
      const unitPriceVal = row['Unit Price'] || row.unitPrice;
      const unitPrice = unitPriceVal ? parseFloat(unitPriceVal) : null;

      if (sku) {
        ordersGrouped[groupKey].items.push({ sku, qty, unitPrice });
      }
    }

    const createdOrders = [];
    const warehouse = await Warehouse.findOne({ where: { companyId, status: 'ACTIVE' }, transaction: t });
    const allProducts = await Product.findAll({ where: { companyId }, transaction: t });
    let count = await SalesOrder.count({ where: { companyId }, transaction: t });

    for (const groupKey of Object.keys(ordersGrouped)) {
      const orderData = ordersGrouped[groupKey];
      if (orderData.items.length === 0) continue;

      count += 1;
      const sequenceNumber = count;
      const finalOrderNumber = orderData.orderNumber 
        ? orderData.orderNumber 
        : `ORD-${Date.now()}-${String(sequenceNumber).padStart(4, '0')}`;

      const salesOrder = await SalesOrder.create({
        companyId,
        orderNumber: finalOrderNumber,
        sequenceNumber,
        customerId: null,
        orderDate: orderData.orderDate,
        requiredDate: orderData.requiredDate,
        requiredDespatchDate: orderData.requiredDate,
        requiredDeliveryDate: orderData.requiredDate,
        priority: orderData.priority,
        salesChannel: orderData.salesChannel,
        orderType: orderData.orderType,
        referenceNumber: orderData.referenceNumber,
        notes: orderData.notes,
        status: 'DRAFT',
        totalAmount: 0,
        createdBy: reqUser.id,
        recipientName: orderData.recipientName,
        addressLine1: orderData.addressLine1,
        addressLine2: orderData.addressLine2,
        addressLine3: orderData.addressLine3,
        town: orderData.town,
        county: orderData.county,
        postcode: orderData.postcode,
        country: orderData.country,
        phone: orderData.phone,
        email: orderData.email,
        courierName: orderData.courierName,
        courierService: orderData.courierService,
        requestedShippingService: orderData.requestedShippingService,
        noOfParcels: orderData.noOfParcels,
        totalWeight: 0.0,
        tags: orderData.tags,
        externalRef: orderData.externalRef,
      }, { transaction: t });

      let total = 0;
      let calculatedWeight = 0;

      for (const item of orderData.items) {
        const product = allProducts.find(p => p.sku === item.sku);
        if (!product) {
          throw new Error(`SKU "${item.sku}" not found in catalog.`);
        }

        const unitPrice = item.unitPrice !== null ? item.unitPrice : product.price;
        const qty = item.qty;
        calculatedWeight += (Number(product.weight || 0) * qty);

        let targetWarehouseId = warehouse?.id;
        if (!targetWarehouseId) {
          const firstStock = await ProductStock.findOne({
            where: { productId: product.id, companyId, quantity: { [Op.gt]: sequelize.col('reserved') }, status: 'ACTIVE' },
            include: [{ model: Warehouse, where: { status: 'ACTIVE' }, required: true, attributes: [] }],
            transaction: t
          });
          targetWarehouseId = firstStock?.warehouseId;
        }
        if (!targetWarehouseId) {
          throw new Error(`Insufficient available stock for product ${product.sku} across all warehouses.`);
        }

        await inventoryService.reserveStockSoft({
          productId: product.id,
          warehouseId: targetWarehouseId,
          quantity: qty,
          referenceId: salesOrder.orderNumber,
          reason: `Order: ${salesOrder.orderNumber}`,
          userId: reqUser.id
        }, t);

        await OrderItem.create({
          salesOrderId: salesOrder.id,
          productId: product.id,
          quantity: qty,
          unitPrice: unitPrice,
          warehouseId: targetWarehouseId
        }, { transaction: t });

        total += Number(unitPrice) * qty;
      }

      await salesOrder.update({
        totalAmount: total,
        totalWeight: calculatedWeight
      }, { transaction: t });

      createdOrders.push(salesOrder.id);
    }

    await t.commit();
    return { success: true, count: createdOrders.length, orderIds: createdOrders };
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

function drawCode39Barcode(doc, value, x, y, height = 30, widthPerModule = 0.75) {
  // Convert value to uppercase and sanitize
  const cleanVal = '*' + String(value || '').toUpperCase().replace(/[^0-9A-Z\-.\s$/+%]/g, '') + '*';
  
  const patterns = {
    '0': '101001101101', '1': '110100101011', '2': '101100101011', '3': '110110010101',
    '4': '101001101011', '5': '110100110101', '6': '101100110101', '7': '101001011011',
    '8': '110100101101', '9': '101100101101', 'A': '110101001011', 'B': '101101001011',
    'C': '110110100101', 'D': '101011001011', 'E': '110101100101', 'F': '101101100101',
    'G': '101010011011', 'H': '110101001101', 'I': '101101001101', 'J': '101011001101',
    'K': '110101010011', 'L': '101101010011', 'M': '110110101001', 'N': '101011010011',
    'O': '110101101001', 'P': '101101101001', 'Q': '101010110011', 'R': '110101011001',
    'S': '101101011001', 'T': '101011011001', 'U': '110010101011', 'V': '100110101011',
    'W': '110011010101', 'X': '100101101011', 'Y': '110010110101', 'Z': '100110110101',
    '-': '100101011011', '.': '110010101101', ' ': '100110101101', '*': '100101101101',
    '$': '100100100101', '/': '100100101001', '+': '100101001001', '%': '101001001001'
  };

  let currentX = x;
  doc.save();
  doc.fillColor('#000000');
  for (let i = 0; i < cleanVal.length; i++) {
    const char = cleanVal[i];
    const pattern = patterns[char];
    if (!pattern) continue;
    for (let j = 0; j < pattern.length; j++) {
      if (pattern[j] === '1') {
        doc.rect(currentX, y, widthPerModule, height);
      }
      currentX += widthPerModule;
    }
    currentX += widthPerModule; // inter-character gap
  }
  doc.fill();
  doc.restore();

  // Print text label under barcode
  const barcodeWidth = currentX - x;
  doc.fontSize(8).fillColor('#000000').font('Helvetica');
  doc.text(String(value), x, y + height + 2, { width: barcodeWidth, align: 'center' });
}

async function generateDespatchNotePdf(id, reqUser) {
  const order = await getById(id, reqUser);
  const company = await Company.findByPk(order.companyId);
  
  const PDFDocument = require('pdfkit');
  const axios = require('axios');
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const crypto = require('crypto');

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const buffers = [];
  doc.on('data', (d) => buffers.push(d));

  // --- HEADER SECTION ---
  let headerImageUrl = order.Client?.header_image_url || company?.header_image_url;
  let logoLoaded = false;
  let currentY = 40;

  if (headerImageUrl) {
    const tempFilePath = path.join(os.tmpdir(), `despatch_logo_${crypto.randomBytes(4).toString('hex')}.jpg`);
    try {
      let finalUrl = headerImageUrl;
      if (finalUrl.includes('cloudinary.com') && finalUrl.includes('/upload/')) {
        finalUrl = finalUrl.replace('/upload/', '/upload/f_jpg,q_auto,w_1200/');
      }
      const separator = finalUrl.includes('?') ? '&' : '?';
      finalUrl += `${separator}t=${Date.now()}`;

      const response = await axios.get(finalUrl, {
        responseType: 'arraybuffer',
        timeout: 15000,
        headers: {
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Expires': '0'
        }
      });

      const buffer = Buffer.from(new Uint8Array(response.data));
      fs.writeFileSync(tempFilePath, buffer);

      if (fs.existsSync(tempFilePath)) {
        if (order.Client?.header_image_url) {
          doc.image(tempFilePath, 40, 15, { width: 515, height: 75 });
          logoLoaded = true;
          currentY = 100;
        } else {
          doc.image(tempFilePath, 40, 15, { fit: [120, 60] });
          logoLoaded = true;
          currentY = 85;
        }
        doc.on('end', () => {
          try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch (e) { }
        });
      }
    } catch (err) {
      console.error('[PDF] Logo load failed:', err.message);
      try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch (e) { }
    }
  }

  // --- COMPANY INFO ON TOP-RIGHT (Only if NOT using client banner) ---
  if (!order.Client?.header_image_url) {
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#333333');
    doc.text(company?.name || '', 300, 20, { align: 'right', width: 255 });
    doc.fontSize(9).font('Helvetica').fillColor('#666666');
    doc.text(company?.address || '', 300, doc.y, { align: 'right', width: 255 });
    if (company?.phone || company?.email) {
      doc.text(`${company?.phone || ''} ${company?.email ? '| ' + company?.email : ''}`, 300, doc.y, { align: 'right', width: 255 });
    }
  }

  currentY = Math.max(logoLoaded ? 105 : 80, doc.y + 20);

  // Separator line
  doc.moveTo(40, currentY).lineTo(555, currentY).strokeColor('#eeeeee').lineWidth(1).stroke();

  doc.y = currentY + 10;

  // Title
  doc.fontSize(20).font('Helvetica-Bold').fillColor('#333333').text('DESPATCH NOTE / PACKING SLIP', 40, doc.y);
  doc.moveDown(0.5);

  // Address and Info Columns
  const infoTop = doc.y;

  // Left Column: Ship To Address
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#555555').text('SHIP TO:', 40, infoTop);
  doc.fontSize(9).font('Helvetica').fillColor('#111111');
  
  const recipientName = order.recipientName || order.Client?.name || '-';
  doc.text(recipientName, 40, doc.y + 3);
  if (order.addressLine1) doc.text(order.addressLine1, 40);
  if (order.addressLine2) doc.text(order.addressLine2, 40);
  if (order.addressLine3) doc.text(order.addressLine3, 40);
  
  let townCountyPostcode = [order.town, order.county, order.postcode].filter(Boolean).join(', ');
  if (townCountyPostcode) {
    doc.text(townCountyPostcode, 40);
  } else {
    const fallbackPostcode = order.postcode || order.Client?.postcode || '';
    const fallbackCity = order.town || order.Client?.city || '';
    const fallbackState = order.county || order.Client?.state || '';
    const fallbackLine = [fallbackCity, fallbackState, fallbackPostcode].filter(Boolean).join(', ');
    if (fallbackLine) doc.text(fallbackLine, 40);
  }
  
  const countryStr = order.country || order.Client?.country || '';
  if (countryStr) doc.text(countryStr.toUpperCase(), 40);

  const phoneStr = order.phone || order.Client?.phone || '';
  const emailStr = order.email || order.Client?.email || '';
  if (phoneStr || emailStr) {
    doc.fillColor('#666666');
    doc.text(`${phoneStr} ${emailStr ? '| ' + emailStr : ''}`, 40);
  }

  // Right Column: Order Details
  const rightColumnX = 320;
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#555555').text('ORDER DETAILS:', rightColumnX, infoTop);
  doc.fontSize(9).font('Helvetica').fillColor('#444444');
  
  let detailY = infoTop + 15;
  const drawDetailRow = (label, value) => {
    doc.font('Helvetica-Bold').fillColor('#555555').text(label, rightColumnX, detailY, { width: 100, continued: true });
    doc.font('Helvetica').fillColor('#111111').text(value);
    detailY = doc.y;
  };

  drawDetailRow('Order Number: ', order.orderNumber);
  drawDetailRow('Seq Number: ', order.sequenceNumber ? String(order.sequenceNumber) : '-');
  if (order.externalRef) drawDetailRow('External Ref: ', order.externalRef);
  
  const orderDateStr = order.orderDate || (order.createdAt ? new Date(order.createdAt).toLocaleDateString('en-GB') : '-');
  drawDetailRow('Order Date: ', orderDateStr);

  const courierName = order.courierName || '-';
  const courierService = order.courierService || '-';
  drawDetailRow('Courier: ', `${courierName} (${courierService})`);
  
  // Render Barcode of Order Number
  const barcodeY = detailY + 10;
  drawCode39Barcode(doc, order.orderNumber, rightColumnX, barcodeY, 30, 0.75);

  // Position below the columns
  doc.y = Math.max(doc.y, barcodeY + 50);
  doc.moveDown();

  doc.fontSize(12).font('Helvetica-Bold').fillColor('#000000').text('Packed Items Checklist', 40, doc.y, { underline: true });
  doc.moveDown(0.5);

  // --- ITEMS TABLE ---
  const tableTop = doc.y;
  doc.fontSize(8).font('Helvetica-Bold').fillColor('#555555');
  doc.text('SKU', 40, tableTop, { width: 100, lineBreak: false });
  doc.text('Product Name', 150, tableTop, { width: 280, lineBreak: false });
  doc.text('Qty Ordered', 440, tableTop, { width: 60, align: 'right', lineBreak: false });
  doc.text('Verified', 510, tableTop, { width: 45, align: 'center', lineBreak: false });

  doc.moveTo(40, tableTop + 14).lineTo(555, tableTop + 14).strokeColor('#cccccc').lineWidth(0.5).stroke();
  doc.y = tableTop + 20;

  for (const item of (order.OrderItems || [])) {
    if (doc.y > 740) {
      doc.addPage();
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#555555');
      doc.text('SKU', 40, 40, { width: 100, lineBreak: false });
      doc.text('Product Name', 150, 40, { width: 280, lineBreak: false });
      doc.text('Qty Ordered', 440, 40, { width: 60, align: 'right', lineBreak: false });
      doc.text('Verified', 510, 40, { width: 45, align: 'center', lineBreak: false });
      doc.moveTo(40, 54).lineTo(555, 54).strokeColor('#cccccc').lineWidth(0.5).stroke();
      doc.y = 60;
    }

    const rowY = doc.y;
    doc.fontSize(8.5).font('Helvetica').fillColor('#111111');
    
    const sku = item.Product?.sku || '-';
    const name = item.Product?.name || item.productName || '-';
    const qty = item.quantity || 0;

    doc.text(sku, 40, rowY, { width: 100, ellipsis: true });
    doc.text(name, 150, rowY, { width: 280, ellipsis: true });
    doc.text(String(qty), 440, rowY, { width: 60, align: 'right' });
    
    // Draw tick box
    doc.rect(525, rowY - 1, 10, 10).strokeColor('#999999').lineWidth(0.5).stroke();

    doc.y = rowY + 18;
  }

  doc.moveDown(1);
  if (doc.y > 700) doc.addPage();

  if (order.notes) {
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#555555').text('Notes / Instructions:', 40, doc.y);
    doc.fontSize(9).font('Helvetica').fillColor('#333333').text(order.notes, 40, doc.y + 3, { width: 480 });
    doc.moveDown();
  }

  doc.fontSize(9).font('Helvetica').fillColor('#666666');
  doc.text('Please verify all contents before accepting delivery. Thank you for your business!', 40, doc.y + 15, { align: 'center', width: 515 });

  doc.end();
  const buffer = await new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(buffers))));
  return { buffer, filename: `DespatchNote-${order.orderNumber}.pdf` };
}

module.exports = { list, getById, create, update, remove, bulkAction, allocateAllOrders, importCsv, generateDespatchNotePdf };

