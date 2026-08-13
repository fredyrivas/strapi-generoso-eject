import type { Schema, Struct } from '@strapi/strapi';

export interface PurchaseCostHistory extends Struct.ComponentSchema {
  collectionName: 'components_purchase_cost_histories';
  info: {
    description: 'Registro de un costo de compra y la fecha en que aplic\u00F3.';
    displayName: 'Historial de costo';
  };
  attributes: {
    cost: Schema.Attribute.Decimal &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    date: Schema.Attribute.Date & Schema.Attribute.Required;
  };
}

declare module '@strapi/strapi' {
  export module Public {
    export interface ComponentSchemas {
      'purchase.cost-history': PurchaseCostHistory;
    }
  }
}
