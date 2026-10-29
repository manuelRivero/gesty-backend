# Resultado esperado — ajustes de pruebas conversacionales

Documento breve para quien prueba el bot por WhatsApp. Describe **cómo debería comportarse** después de los ajustes (no el detalle técnico).

---

## Reservas

### Elegir horario escribiendo (ej. “Sí a las 19:00”)
Antes el bot a veces volvía a mostrar la lista de horarios.  
**Ahora:** si escribís un horario de los ofrecidos, lo anota y sigue (personas, ambiente o confirmación). No debería re-listar como si no hubiera escuchado.

### Decir cuántas personas (ej. “4”)
Antes a veces repetía la pregunta de cantidad.  
**Ahora:** si respondés con el número, lo anota y avanza. Si pedís más personas de las que el local puede, te aclara el máximo y te pide que ajustes.

### Horario o ambiente que no está en la lista
Si pedís algo que no está entre las opciones mostradas, el bot **te lo dice** y vuelve a ofrecer la lista (no cambia de tema en silencio).

---

## Pedido / menú

### Pedís algo que no está en la lista que te mostró (ej. empanadas → “y de mozzarella”)
Antes podía saltar a otra categoría sin explicar.  
**Ahora:** te aclara que entre esas opciones no está lo que pediste, y te pregunta si querés que busque en el menú o si preferís elegir de la lista. Solo busca fuera si vos aceptás.

### Variedades de un plato
Si pedís una variedad que ese plato no tiene, te lo dice y te recuerda las opciones de ese plato (no te manda a otro producto sin avisar).

### Pago en el checkout
Si nombrás un método que el local no ofrece, te lo aclara y te vuelve a mostrar los métodos disponibles.

---

## Qué no tratamos como error de estas pruebas

- **“Menú para compartir para 3 personas”** sin haber dicho “3”: suele venir de una conversación anterior (estado viejo del chat). Para probar limpio, conviene **cancelar / reiniciar el pedido** (o empezar chat fresco) antes de cada escenario.
- **“No tengo información” de un plato:** muchas veces la ficha en el menú no tiene descripción/ingredientes cargados. Si el plato sí tiene ficha completa en el panel y el bot igual no responde, ahí sí conviene reportarlo.

---

## Cómo probar rápido

1. Empezá con pedido/reserva limpios (sin borrador viejo).
2. **Reserva:** fecha → lista de horarios → tipá “a las XX:XX” → tipá “4” → confirmá.
3. **Menú:** sumá un plato → si ofrece acompañamientos → pedí algo que **no** esté en esa lista → deberías ver la aclaración y la pregunta antes de que busque otra cosa.
