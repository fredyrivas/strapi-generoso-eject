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

export interface RecetaIngrediente extends Struct.ComponentSchema {
  collectionName: 'components_receta_ingredientes';
  info: {
    description: 'Ingrediente y cantidad utilizados en una receta.';
    displayName: 'Ingrediente';
  };
  attributes: {
    cantidad: Schema.Attribute.Decimal &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    ingrediente: Schema.Attribute.Relation<
      'oneToOne',
      'api::purchase-item.purchase-item'
    > &
      Schema.Attribute.Required;
    unidad: Schema.Attribute.Enumeration<['g', 'ml', 'pz']> &
      Schema.Attribute.Required;
  };
}

export interface RecetaPasoPreparacion extends Struct.ComponentSchema {
  collectionName: 'components_receta_pasos_preparacion';
  info: {
    description: 'Paso individual del procedimiento de una receta.';
    displayName: 'Paso de preparaci\u00F3n';
  };
  attributes: {
    descripcion: Schema.Attribute.Text & Schema.Attribute.Required;
    paso: Schema.Attribute.Integer &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMax<
        {
          min: 1;
        },
        number
      >;
  };
}

declare module '@strapi/strapi' {
  export module Public {
    export interface ComponentSchemas {
      'purchase.cost-history': PurchaseCostHistory;
      'receta.ingrediente': RecetaIngrediente;
      'receta.paso-preparacion': RecetaPasoPreparacion;
    }
  }
}
